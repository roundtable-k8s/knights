/**
 * Task execution: one Claude Agent SDK query() — i.e. one Claude Code process —
 * per task.
 *
 * Sessions: with CLAUDE_SESSION_MODE=run (default), tasks carrying the same
 * chain runId resume the same Claude Code session, so a chain's steps share
 * context, and a new runId starts fresh (the same no-bleed rule pi-knight
 * follows, #31). Tasks without a runId start a fresh session: unlike pi-knight's
 * forever-session, an ever-growing Claude Code session would spend plan limits
 * on re-reading old context. Long-term memory lives in files on the PVC
 * (MEMORY.md, memory/*.md), as the knight contract already asks.
 */
import { query, type McpServerConfig, type Options, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnightConfig } from "./config.js";
import { buildChildEnv } from "./auth.js";
import { buildHooks } from "./hooks.js";
import { log } from "./logger.js";
import { recordRateLimit } from "./plan-limits.js";
import { buildAppendPrompt } from "./prompt.js";
import { linkSkills } from "./skills.js";
import { createRoundtableServer, ROUNDTABLE_TOOL_IDS } from "./tools.js";
import { classifyResult, type TaskResult } from "./result.js";

export type { TaskResult } from "./result.js";

/**
 * Built-in tools that need a human, schedule work outside the task, or belong to
 * interactive Claude Code. An unattended knight must not reach for them.
 */
export const DISALLOWED_TOOLS = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "PushNotification",
  "SendUserMessage",
  "SendUserFile",
  "ReadNotifications",
  "Monitor",
  "ShowOnboardingRolePicker",
];

/** Built-ins to make sure are present (native builds otherwise fold search into Bash). */
const EXTRA_BUILTINS = ["Grep", "Glob", "WebFetch", "WebSearch"];

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

/** External MCP servers: /config/mcp.json (ConfigMap) then MCP_SERVERS_JSON (env) on top. */
export function loadMcpServers(config: KnightConfig): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  const merge = (source: string, raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      const map = parsed?.mcpServers ?? parsed; // accept .mcp.json shape or a bare map
      if (map && typeof map === "object" && !Array.isArray(map)) Object.assign(servers, map);
      else log.warn("Ignoring MCP config that is not an object", { source });
    } catch (err) {
      log.warn("Ignoring unparseable MCP config", { source, error: String(err) });
    }
  };
  const file = join(config.configDir, "mcp.json");
  if (existsSync(file)) merge(file, readFileSync(file, "utf8"));
  if (config.mcpServersJson) merge("MCP_SERVERS_JSON", config.mcpServersJson);
  delete servers["roundtable"]; // reserved for the built-in NATS tools
  return servers;
}

export function buildOptions(
  config: KnightConfig,
  abortController: AbortController,
  resumeSessionId: string | undefined,
): Options {
  const external = loadMcpServers(config);
  const options: Options = {
    abortController,
    cwd: config.workDir,
    model: config.claudeModel,
    systemPrompt: { type: "preset", preset: "claude_code", append: buildAppendPrompt(config) },
    // 'user' loads $CLAUDE_CONFIG_DIR (skills, settings); 'project' loads CLAUDE.md
    // and .claude/ in the workspace — the knight may keep its own there.
    settingSources: ["user", "project"],
    skills: "all",
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: [...DISALLOWED_TOOLS, ...config.extraDisallowedTools],
    mcpServers: { ...external, roundtable: createRoundtableServer() },
    allowedTools: [...EXTRA_BUILTINS, ...ROUNDTABLE_TOOL_IDS, ...Object.keys(external).map((n) => `mcp__${n}`)],
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

export async function executeTask(
  task: string,
  taskId: string,
  config: KnightConfig,
  signal: AbortSignal,
  runId?: string,
  queryFn: QueryFn = query,
): Promise<TaskResult> {
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
      model: config.claudeModel ?? "default",
      skills: skills.names.length,
      taskLength: task.length,
    });

    const started = Date.now();
    let result: SDKResultMessage | undefined;
    let sessionId: string | undefined;
    let lastAssistantText = "";
    let assistantError: string | undefined;
    let apiKeySource: string | undefined;

    try {
      const stream = queryFn({ prompt: task, options: buildOptions(config, abortController, resume) });
      for await (const msg of stream as AsyncIterable<SDKMessage>) {
        if ("session_id" in msg && typeof msg.session_id === "string") sessionId = msg.session_id;
        switch (msg.type) {
          case "system":
            if (msg.subtype === "init") {
              apiKeySource = msg.apiKeySource;
              log.info("Claude Code session started", {
                taskId,
                sessionId: msg.session_id,
                model: msg.model,
                version: msg.claude_code_version,
                apiKeySource,
                mcp: msg.mcp_servers?.map((s) => `${s.name}:${s.status}`),
                skills: msg.skills?.length,
              });
              // Belt and braces for the credential stripping in auth.ts.
              if (config.authMode === "subscription" && (apiKeySource === "ANTHROPIC_API_KEY" || apiKeySource === "apiKeyHelper")) {
                abortController.abort();
                throw new Error(`Refusing to run: subscription mode but Claude Code authenticated via ${apiKeySource}`);
              }
            }
            break;
          case "assistant": {
            if (msg.parent_tool_use_id) break; // subagent chatter, not the deliverable
            if (msg.error) assistantError = msg.error;
            const content = (msg.message as { content?: Array<{ type: string; text?: string }> })?.content;
            const text = Array.isArray(content)
              ? content.filter((b) => b.type === "text" && b.text).map((b) => b.text!.trim()).join("\n").trim()
              : "";
            if (text) lastAssistantText = text;
            break;
          }
          case "rate_limit_event":
            recordRateLimit(config.knightName, msg.rate_limit_info);
            if (msg.rate_limit_info.status !== "allowed") {
              log.warn("Claude plan limit warning", { ...msg.rate_limit_info });
            }
            break;
          case "result":
            result = msg;
            break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const outcome = classifyResult({
        result,
        lastAssistantText,
        assistantError,
        thrown: message,
        aborted: signal.aborted,
        config,
        durationMs: Date.now() - started,
      });
      remember({ taskId, runId, sessionId, success: false, costUsd: outcome.cost, durationMs: Date.now() - started, turns: result?.num_turns ?? 0, finishedAt: new Date().toISOString(), error: outcome.error });
      return outcome;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }

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
      lastAssistantText,
      assistantError,
      aborted: signal.aborted,
      config,
      durationMs: Date.now() - started,
    });
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
}
