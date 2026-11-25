/**
 * cli runtime: run a task as one headless `claude -p` process (the official
 * Claude Code CLI) and turn its stream-json output into the same message
 * stream the sdk runtime gets from query().
 *
 * Per task the runner writes a private temp dir with:
 *   - system-prompt.md  → --append-system-prompt-file (SOUL/IDENTITY/AGENTS/TOOLS can be large)
 *   - mcp.json          → --mcp-config: the Round Table tools as a stdio server
 *                         (`node dist/index.js mcp`) merged with /config/mcp.json and MCP_SERVERS_JSON
 *   - settings.json     → --settings: the Bash guardrails as a PreToolUse command hook
 *                         (`node dist/index.js hook pretooluse`)
 * The prompt goes in on stdin, so its size is not bound by argv limits.
 *
 * Every flag used here was checked against `claude --help` of the pinned CLI
 * (2.1.329), except --max-turns and --append-system-prompt-file, which the CLI
 * accepts without listing them (the Agent SDK passes --max-turns itself); the
 * end-to-end test in tests/cli-e2e.test.ts runs the real binary with all of them.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildChildEnv } from "./auth.js";
import type { KnightConfig } from "./config.js";
import { DISALLOWED_TOOLS, EXTRA_BUILTINS, loadMcpServers } from "./mcp-config.js";
import { log } from "@roundtable/knight-core";
import { buildAppendPrompt } from "./prompt.js";
import { roundtableToolIds } from "./tools.js";

/**
 * How to re-invoke this program (for the MCP server and the hook): node plus
 * dist/index.js in the image. Under tsx (tests, `npm run dev`) there is no
 * index.js next to this file, so fall back to node + tsx + src/index.ts.
 */
export function defaultSelfCommand(): string[] {
  const js = fileURLToPath(new URL("./index.js", import.meta.url));
  if (existsSync(js)) return [process.execPath, js];
  const ts = fileURLToPath(new URL("./index.ts", import.meta.url));
  return [process.execPath, "--import", import.meta.resolve("tsx"), ts];
}

/** POSIX shell quoting for the hook command line (Claude Code runs it through a shell). */
export function shellQuote(args: string[]): string {
  return args.map((a) => (/^[A-Za-z0-9_\/.:=@%+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

export interface CliInvocation {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** Files to write before spawning: absolute path → content. */
  files: Record<string, string>;
}

export interface CliInvocationOptions {
  /** Session to resume (same chain run). */
  resume?: string;
  /** Private per-task directory for the generated files. */
  taskDir: string;
  /** Per-task working directory the process runs in; defaults to config.workDir. */
  cwd?: string;
  /** Command that runs this program; defaults to defaultSelfCommand(). */
  selfCommand?: string[];
  /** Pod environment (tests pass their own). */
  env?: NodeJS.ProcessEnv;
}

/** Non-secret settings the stdio MCP server needs; everything else it inherits from Claude Code's env. */
function mcpServerEnv(config: KnightConfig): Record<string, string> {
  return {
    KNIGHT_NAME: config.knightName,
    NATS_RESULTS_PREFIX: config.natsResultsPrefix,
    LOG_LEVEL: config.logLevel,
  };
}

export function buildCliInvocation(config: KnightConfig, opts: CliInvocationOptions): CliInvocation {
  const self = opts.selfCommand ?? defaultSelfCommand();
  const external = loadMcpServers(config);
  const mcpPath = join(opts.taskDir, "mcp.json");
  const settingsPath = join(opts.taskDir, "settings.json");
  const promptPath = join(opts.taskDir, "system-prompt.md");

  const mcpConfig = {
    mcpServers: {
      ...external,
      roundtable: {
        type: "stdio",
        command: self[0]!,
        args: [...self.slice(1), "mcp"],
        env: mcpServerEnv(config),
        alwaysLoad: true,
      },
    },
  };
  const settings = {
    // Knights commit and open PRs as the Round Table bot; no Claude Code
    // co-author trailer or "Generated with Claude Code" footer.
    attribution: { commit: "", pr: "" },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: `${shellQuote(self)} hook pretooluse`, timeout: 30 }] },
      ],
    },
  };

  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "bypassPermissions",
    "--allow-dangerously-skip-permissions",
    "--append-system-prompt-file", promptPath,
    // 'user' loads $CLAUDE_CONFIG_DIR (skills, settings); 'project' loads CLAUDE.md
    // and .claude/ from cwd, where the knight's root ones are linked per task.
    "--setting-sources", "user,project",
    "--settings", settingsPath,
    "--mcp-config", mcpPath,
    "--disallowedTools", [...DISALLOWED_TOOLS, ...config.extraDisallowedTools].join(","),
    "--allowedTools", [...EXTRA_BUILTINS, ...roundtableToolIds(), ...Object.keys(external).map((n) => `mcp__${n}`)].join(","),
  ];
  if (config.claudeModel) args.push("--model", config.claudeModel);
  if (config.effort) args.push("--effort", config.effort);
  if (config.maxTurns > 0) args.push("--max-turns", String(config.maxTurns));
  if (config.maxBudgetUsd > 0) args.push("--max-budget-usd", String(config.maxBudgetUsd));
  if (opts.resume) args.push("--resume", opts.resume);

  return {
    bin: config.claudeBin,
    args,
    cwd: opts.cwd ?? config.workDir,
    env: buildChildEnv(
      config.authMode,
      {
        CLAUDE_CONFIG_DIR: config.claudeConfigDir,
        // No interactive onboarding, auto-updates or telemetry prompts in a pod.
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      opts.env ?? process.env,
      "cli",
    ),
    files: {
      [promptPath]: buildAppendPrompt(config, opts.cwd),
      [mcpPath]: JSON.stringify(mcpConfig, null, 2),
      [settingsPath]: JSON.stringify(settings, null, 2),
    },
  };
}

/** Parse one stdout line. Non-JSON lines (there should be none) return undefined. */
export function parseStreamLine(line: string): SDKMessage | undefined {
  const t = line.trim();
  if (!t.startsWith("{")) return undefined;
  try {
    const msg = JSON.parse(t);
    return msg && typeof msg === "object" && typeof msg.type === "string" ? (msg as SDKMessage) : undefined;
  } catch {
    return undefined;
  }
}

/** Grace period between SIGTERM and SIGKILL when a task is aborted. */
const KILL_GRACE_MS = 5000;
const STDERR_TAIL = 4000;
/** The result message is the last one; a CLI that lingers after it is stopped. */
const RESULT_EXIT_GRACE_MS = 10_000;

/**
 * Spawn `claude -p` and yield its stream-json messages. Throws when the CLI
 * cannot start, or exits non-zero without having printed a result message.
 * Aborting the signal (task timeout, shutdown) or leaving the loop early
 * terminates the process.
 */
export async function* runClaudeCli(prompt: string, inv: CliInvocation, signal: AbortSignal): AsyncGenerator<SDKMessage> {
  const child = spawn(inv.bin, inv.args, { cwd: inv.cwd, env: inv.env, stdio: ["pipe", "pipe", "pipe"] });
  let spawnError: Error | undefined;
  child.on("error", (e) => (spawnError = e));
  const exited = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolve) =>
    child.on("close", (code, sig) => resolve({ code, sig })),
  );

  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    stderrTail = (stderrTail + d).slice(-STDERR_TAIL);
    log.debug("claude stderr", { data: d.slice(0, 2000) });
  });

  let killTimer: NodeJS.Timeout | undefined;
  const kill = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    killTimer.unref();
  };
  if (signal.aborted) kill();
  else signal.addEventListener("abort", kill, { once: true });

  child.stdin.on("error", () => {}); // EPIPE if the CLI exits before reading the prompt
  child.stdin.end(prompt);

  let sawResult = false;
  try {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of rl) {
      const msg = parseStreamLine(line);
      if (!msg) {
        if (line.trim()) log.debug("claude stdout (not stream-json)", { line: line.slice(0, 500) });
        continue;
      }
      if (msg.type === "result" && !sawResult) {
        sawResult = true;
        setTimeout(kill, RESULT_EXIT_GRACE_MS).unref();
      }
      yield msg;
    }
    const { code, sig } = await exited;
    if (spawnError) throw new Error(`Could not start the Claude Code CLI (${inv.bin}): ${spawnError.message}`);
    if (!sawResult && (code !== 0 || sig)) {
      const detail = stderrTail.trim().split("\n").slice(-5).join(" | ");
      throw new Error(`Claude Code process exited with ${sig ? `signal ${sig}` : `code ${code}`}${detail ? `: ${detail}` : ""}`);
    }
  } finally {
    signal.removeEventListener("abort", kill);
    kill(); // no-op when already exited; stops the CLI when the consumer bailed out early
    await exited;
    if (killTimer) clearTimeout(killTimer);
  }
}

/** Write the invocation's files into a fresh private temp dir; returns the cleanup. */
export function makeTaskDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "claude-knight-task-")); // mode 0700
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function writeInvocationFiles(inv: CliInvocation): void {
  for (const [path, content] of Object.entries(inv.files)) writeFileSync(path, content, { mode: 0o600 });
}
