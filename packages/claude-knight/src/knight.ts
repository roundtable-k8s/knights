/**
 * Task execution: one Claude Code process per task, either the official CLI run
 * headless (`claude -p`, cli runtime, cli-runner.ts) or the Agent SDK's query()
 * (sdk runtime). Both produce the same message stream (stream.ts), so sessions,
 * cost accounting and result classification are shared.
 *
 * Sessions: with CLAUDE_SESSION_MODE=run (default), tasks carrying the same
 * chain runId resume the same Claude Code session, so a chain's steps share
 * context, and a new runId starts fresh (the same no-bleed rule pi-knight
 * follows, #31). Tasks without a runId start a fresh session: unlike pi-knight's
 * forever-session, an ever-growing Claude Code session would spend plan limits
 * on re-reading old context. Long-term memory lives in files on the PVC
 * (MEMORY.md, memory/*.md), as the knight contract already asks.
 */
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveClaudeModel, type KnightConfig } from "./config.js";
import { buildChildEnv, checkRuntime } from "./auth.js";
import { buildCliInvocation, makeTaskDir, runClaudeCli, writeInvocationFiles, type CliInvocation } from "./cli-runner.js";
import { buildHooks } from "./hooks.js";
import { DISALLOWED_TOOLS, EXTRA_BUILTINS, loadMcpServers } from "./mcp-config.js";
import { log } from "@roundtable/knight-core";
import { buildAppendPrompt } from "./prompt.js";
import { linkSkills } from "./skills.js";
import { applyMessage, newStreamState } from "./stream.js";
import { createRoundtableServer, roundtableToolIds } from "./tools.js";
import { classifyResult, type TaskResult } from "./result.js";

export type { TaskResult } from "./result.js";
export { DISALLOWED_TOOLS, loadMcpServers } from "./mcp-config.js";

// runId → Claude Code session id, for resuming within a chain run.
const runSessions = new Map<string, string>();

// sessionId → cumulative total_cost_usd last reported. A resumed session reports
// cost for the whole session, not just this query, so per-task cost is the delta.
const sessionCost = new Map<string, number>();
const MAX_TRACKED_RUNS = 200;

// Tasks of the same run must not resume one session concurrently.
const runLocks = new Map<string, Promise<void>>();

// Last N completed tasks, for introspection.
export interface TaskRecord {
  taskId: string;
  runId?: string;
  sessionId?: string;
  success: boolean;
  costUsd: number;
  durationMs: number;
  turns: number;
  finishedAt: string;
  error?: string;
}
const recentTasks: TaskRecord[] = [];
export function getRecentTasks(): TaskRecord[] {
  return [...recentTasks];
}
function remember(rec: TaskRecord): void {
  recentTasks.push(rec);
  if (recentTasks.length > 50) recentTasks.shift();
}

function rememberRunSession(runId: string, sessionId: string): void {
  runSessions.delete(runId);
  runSessions.set(runId, sessionId);
  while (runSessions.size > MAX_TRACKED_RUNS) {
    const oldest = runSessions.keys().next().value;
    if (oldest === undefined) break;
    runSessions.delete(oldest);
  }
}

export function buildOptions(
  config: KnightConfig,
  abortController: AbortController,
  resumeSessionId: string | undefined,
  cwd: string = config.workDir,
): Options {
  const external = loadMcpServers(config);
  const options: Options = {
    abortController,
    cwd,
    model: config.claudeModel,
    systemPrompt: { type: "preset", preset: "claude_code", append: buildAppendPrompt(config, cwd === config.workDir ? undefined : cwd) },
    // 'user' loads $CLAUDE_CONFIG_DIR (skills, settings); 'project' loads CLAUDE.md
    // and .claude/ from cwd — the per-task dir, where linkProjectConfig() links
    // the knight's own from the root workdir.
    settingSources: ["user", "project"],
    skills: "all",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: [...DISALLOWED_TOOLS, ...config.extraDisallowedTools],
    mcpServers: { ...external, roundtable: createRoundtableServer() },
    allowedTools: [...EXTRA_BUILTINS, ...roundtableToolIds(), ...Object.keys(external).map((n) => `mcp__${n}`)],
    hooks: buildHooks(),
    env: buildChildEnv(config.authMode, {
      CLAUDE_CONFIG_DIR: config.claudeConfigDir,
      CLAUDE_AGENT_SDK_CLIENT_APP: "roundtable-claude-knight/0.1.0",
      // No interactive onboarding, auto-updates or telemetry prompts in a pod.
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    }),
    stderr: (data: string) => log.debug("claude stderr", { data: data.slice(0, 2000) }),
  };
  if (resumeSessionId) options.resume = resumeSessionId;
  if (config.effort) options.effort = config.effort as Options["effort"];
  if (config.maxTurns > 0) options.maxTurns = config.maxTurns;
  if (config.maxBudgetUsd > 0) options.maxBudgetUsd = config.maxBudgetUsd;
  return options;
}

/**
 * Per-task working directory: $KNIGHT_WORKDIR/work/<runId|taskId>-<hash>, sanitised.
 * Keyed on runId so a resumed session (stored per cwd) finds its transcript.
 */
export function taskWorkDir(config: KnightConfig, taskId: string, runId?: string): string {
  const raw = runId || taskId;
  // The hash of the raw id keeps `a/b` and `a_b` (same after sanitising) in distinct dirs; stable per run.
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  const name = raw.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 120 - 9) || "task";
  return join(config.workDir, "work", `${name}-${hash}`);
}

/**
 * Remove a directory tree even when it holds read-only files/dirs (e.g. Go
 * envtest binaries). Adds owner write (+exec on dirs) before removing, and
 * never follows symlinks: links are unlinked, their targets left untouched.
 */
export function forceRemoveTree(path: string): void {
  const fix = (p: string): void => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    try {
      chmodSync(p, st.mode | (st.isDirectory() ? 0o700 : 0o200));
    } catch {
      /* best effort; rmSync reports real failures */
    }
    if (st.isDirectory()) for (const name of readdirSync(p)) fix(join(p, name));
  };
  fix(path);
  rmSync(path, { recursive: true, force: true });
}

const activeWorkDirs = new Set<string>();

/** Remove per-task dirs under <workDir>/work older than maxAgeMs that no running task owns. */
export function sweepStaleWorkDirs(config: KnightConfig, maxAgeMs = 24 * 3600 * 1000): number {
  const root = join(config.workDir, "work");
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    const dir = join(root, name);
    if (activeWorkDirs.has(dir)) continue;
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || Date.now() - st.mtimeMs < maxAgeMs) continue;
      forceRemoveTree(dir);
      removed++;
    } catch (e) {
      log.warn("Could not sweep stale task working directory", { dir, error: String(e) });
    }
  }
  if (removed) log.info("Swept stale task working directories", { removed });
  return removed;
}

/**
 * Project settings resolve against cwd, which is the per-task dir. Symlink the
 * knight's root CLAUDE.md and .claude/ into it so they keep applying.
 */
export function linkProjectConfig(config: KnightConfig, cwd: string): void {
  for (const name of ["CLAUDE.md", ".claude"]) {
    const src = join(config.workDir, name);
    const dest = join(cwd, name);
    if (!existsSync(src) || existsSync(dest)) continue;
    try {
      symlinkSync(src, dest);
    } catch (e) {
      log.warn("Could not link project config into task directory", { name, cwd, error: String(e) });
    }
  }
}

async function withRunLock<T>(runId: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!runId) return fn();
  const prev = runLocks.get(runId) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chained = prev.then(() => mine);
  runLocks.set(runId, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (runLocks.get(runId) === chained) runLocks.delete(runId);
  }
}

export type QueryFn = typeof query;

/** Test seams: replace the SDK's query() or the CLI invocation. */
export interface ExecuteOverrides {
  queryFn?: QueryFn;
  /** Adjust the generated CLI invocation before it runs (tests point it at a fake binary). */
  cliInvocation?: (inv: CliInvocation) => CliInvocation;
  /** Per-task model (TaskPayload.model); replaces the knight's CLAUDE_MODEL for this task. Must be a Claude model. */
  model?: string;
}

/** One task's message stream from the configured runtime, plus cleanup for its temp files. */
function openStream(
  task: string,
  config: KnightConfig,
  abortController: AbortController,
  resume: string | undefined,
  overrides: ExecuteOverrides,
  cwd: string,
): { stream: AsyncIterable<SDKMessage>; cleanup: () => void } {
  if (config.runtime === "sdk") {
    const queryFn = overrides.queryFn ?? query;
    return { stream: queryFn({ prompt: task, options: buildOptions(config, abortController, resume, cwd) }), cleanup: () => {} };
  }
  const { dir, cleanup } = makeTaskDir();
  try {
    let inv = buildCliInvocation(config, { resume, taskDir: dir, cwd });
    if (overrides.cliInvocation) inv = overrides.cliInvocation(inv);
    writeInvocationFiles(inv);
    return { stream: runClaudeCli(task, inv, abortController.signal), cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

export async function executeTask(
  task: string,
  taskId: string,
  baseConfig: KnightConfig,
  signal: AbortSignal,
  runId?: string,
  overrides: QueryFn | ExecuteOverrides = {},
): Promise<TaskResult> {
  const over: ExecuteOverrides = typeof overrides === "function" ? { queryFn: overrides } : overrides;
  let config = baseConfig;
  if (over.model) {
    // A per-task model replaces CLAUDE_MODEL for this task only. Non-Claude ids are a
    // task error, never a silent fallback to the knight default.
    const model = resolveClaudeModel(undefined, over.model);
    if (!model) {
      const error = `Unsupported model "${over.model}": claude-knight only runs Claude models (aliases like sonnet/opus/haiku or claude-* ids)`;
      log.warn("Task rejected: unsupported model", { taskId, model: over.model });
      return {
        result: error,
        success: false,
        error,
        cost: 0,
        billing: baseConfig.authMode,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        model: baseConfig.claudeModel ?? "claude-code-default",
        turns: 0,
      };
    }
    config = { ...baseConfig, claudeModel: model };
  }
  // main.ts refuses this at startup; never run a plan token through the SDK regardless.
  const runtimeProblem = checkRuntime(config.authMode, config.runtime);
  if (runtimeProblem) throw new Error(runtimeProblem);
  return withRunLock(runId, async () => {
    mkdirSync(config.claudeConfigDir, { recursive: true });
    const skills = linkSkills(config.skillsDir, config.claudeConfigDir);

    const resume = config.sessionMode === "run" && runId ? runSessions.get(runId) : undefined;
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (signal.aborted) abortController.abort();
    else signal.addEventListener("abort", onAbort, { once: true });

    log.info("Executing task", {
      taskId,
      runId: runId ?? null,
      resume: resume ?? null,
      runtime: config.runtime,
      model: config.claudeModel ?? "claude-code-default",
      skills: skills.names.length,
      taskLength: task.length,
    });

    const started = Date.now();
    const state = newStreamState();
    const ctx = { config, taskId, countTools: config.runtime === "cli" };
    let cleanup = () => {};
    const cwd = taskWorkDir(config, taskId, runId);
    activeWorkDirs.add(cwd);
    const removeWorkDir = (failed: boolean) => {
      activeWorkDirs.delete(cwd);
      if (failed && process.env["DEBUG"]) return log.info("Keeping task working directory (DEBUG)", { taskId, cwd });
      try {
        forceRemoveTree(cwd);
      } catch (e) {
        log.warn("Could not remove task working directory", { taskId, cwd, error: String(e) });
      }
    };

    try {
      mkdirSync(cwd, { recursive: true });
      linkProjectConfig(config, cwd);
      const opened = openStream(task, config, abortController, resume, over, cwd);
      cleanup = opened.cleanup;
      for await (const msg of opened.stream) applyMessage(msg, state, ctx);
    } catch (err) {
      abortController.abort();
      const message = err instanceof Error ? err.message : String(err);
      const outcome = classifyResult({
        result: state.result,
        lastAssistantText: state.lastAssistantText,
        assistantError: state.assistantError,
        thrown: message,
        aborted: signal.aborted,
        config,
        durationMs: Date.now() - started,
      });
      removeWorkDir(true);
      remember({ taskId, runId, sessionId: state.sessionId, success: false, costUsd: outcome.cost, durationMs: Date.now() - started, turns: state.result?.num_turns ?? 0, finishedAt: new Date().toISOString(), error: outcome.error });
      return outcome;
    } finally {
      signal.removeEventListener("abort", onAbort);
      cleanup();
    }

    const sessionId = state.sessionId;
    let result = state.result;
    if (sessionId && runId && config.sessionMode === "run") rememberRunSession(runId, sessionId);
    if (result && resume) {
      const cumulative = result.total_cost_usd;
      const prior = sessionCost.get(resume) ?? 0;
      result = { ...result, total_cost_usd: Math.max(0, cumulative - prior) };
      if (sessionId) sessionCost.set(sessionId, cumulative);
    } else if (result && sessionId) {
      sessionCost.set(sessionId, result.total_cost_usd);
    }
    while (sessionCost.size > MAX_TRACKED_RUNS) {
      const oldest = sessionCost.keys().next().value;
      if (oldest === undefined) break;
      sessionCost.delete(oldest);
    }

    const outcome = classifyResult({
      result,
      lastAssistantText: state.lastAssistantText,
      assistantError: state.assistantError,
      aborted: signal.aborted,
      config,
      durationMs: Date.now() - started,
      prs: state.prs,
    });
    removeWorkDir(!outcome.success);
    remember({
      taskId,
      runId,
      sessionId,
      success: outcome.success,
      costUsd: outcome.cost,
      durationMs: Date.now() - started,
      turns: result?.num_turns ?? 0,
      finishedAt: new Date().toISOString(),
      error: outcome.error,
    });
    log.info("Task completed", {
      taskId,
      success: outcome.success,
      sessionId,
      turns: result?.num_turns,
      costUsd: outcome.cost,
      billing: outcome.billing,
      inputTokens: outcome.tokens.input,
      cachedInputTokens: outcome.tokens.cacheRead,
      outputTokens: outcome.tokens.output,
      ...(outcome.error ? { error: outcome.error } : {}),
    });
    return outcome;
  });
}

/** Test hook. */
export function resetKnightState(): void {
  runSessions.clear();
  runLocks.clear();
  sessionCost.clear();
  recentTasks.length = 0;
  activeWorkDirs.clear();
}
