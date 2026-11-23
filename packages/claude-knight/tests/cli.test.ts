/**
 * cli runtime: argument and file generation for `claude -p`, and executeTask
 * against a fake claude binary that replays stream-json fixtures.
 *
 * Fixtures (tests/fixtures/stream/):
 *   success.jsonl, tool-use.jsonl  recorded from the real CLI 2.1.329 against the mock Messages API
 *   auth-error.jsonl               recorded from the real CLI against api.anthropic.com with an invalid OAuth token
 *   api-key-auth.jsonl             recorded from the real CLI with ANTHROPIC_API_KEY set (init apiKeySource)
 *   usage-limit.jsonl              synthesized from auth-error.jsonl: rate_limit_event (warning, then rejected),
 *                                  an assistant rate_limit error with the CLI's limit text, an is_error result
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type KnightConfig } from "../src/config.js";
import { buildCliInvocation, type CliInvocation, parseStreamLine, shellQuote } from "../src/cli-runner.js";
import { DISALLOWED_TOOLS, executeTask, getRecentTasks, resetKnightState } from "../src/knight.js";
import { checkReserve, resetPlanLimits } from "../src/plan-limits.js";
import { registry } from "../src/metrics.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FAKE = join(here, "helpers", "fake-claude.mjs");
const fixture = (name: string) => join(here, "fixtures", "stream", `${name}.jsonl`);

const root = mkdtempSync(join(tmpdir(), "ck-cli-"));
const work = join(root, "data");
const configDir = join(root, "config");
mkdirSync(work, { recursive: true });
mkdirSync(configDir, { recursive: true });
writeFileSync(join(configDir, "mcp.json"), JSON.stringify({ mcpServers: { vault: { type: "http", url: "http://from-file" }, files: { command: "mcp-files" } } }));
writeFileSync(join(configDir, "SOUL.md"), "I am the soul of Gawain.");

const record = join(root, "record.json");
// The pod env: a subscription token plus credentials that must not reach Claude Code.
process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
process.env.ANTHROPIC_API_KEY = "sk-ant-api03-must-be-stripped";
process.env.ANTHROPIC_BASE_URL = "http://gateway.invalid";
process.env.CLAUDE_CODE_ENTRYPOINT = "sdk-ts";
process.env.FAKE_CLAUDE_RECORD = record;
// Keep the per-task temp dirs somewhere we can inspect.
const tasksTmp = join(root, "tmp");
mkdirSync(tasksTmp);
process.env.TMPDIR = tasksTmp;

const env = {
  KNIGHT_NAME: "Gawain",
  SUBSCRIBE_TOPICS: "rt.tasks.security.>",
  KNIGHT_MODEL: "anthropic/claude-sonnet-4.6",
  KNIGHT_WORKDIR: work,
  KNIGHT_SKILLS_DIR: join(root, "skills"),
  KNIGHT_CONFIG_DIR: configDir,
  NATS_RESULTS_PREFIX: "rt.results",
  MCP_SERVERS_JSON: JSON.stringify({ vault: { type: "http", url: "http://from-env" } }),
  CLAUDE_BIN: FAKE,
};
const config = loadConfig(env);

function lastCall(): { argv: string[]; stdin: string; env: Record<string, string>; cwd: string; files: Record<string, string | undefined> } {
  return JSON.parse(readFileSync(record, "utf8"));
}
const flag = (argv: string[], name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

function useFixture(name: string, opts: { exit?: number; stderr?: string; hang?: boolean } = {}) {
  process.env.FAKE_CLAUDE_FIXTURE = fixture(name);
  process.env.FAKE_CLAUDE_EXIT = String(opts.exit ?? 0);
  if (opts.stderr) process.env.FAKE_CLAUDE_STDERR = opts.stderr;
  else delete process.env.FAKE_CLAUDE_STDERR;
  if (opts.hang) process.env.FAKE_CLAUDE_HANG = "1";
  else delete process.env.FAKE_CLAUDE_HANG;
}

const run = (task: string, runId?: string, cfg: KnightConfig = config, signal = new AbortController().signal) =>
  executeTask(task, `t-${Math.random().toString(36).slice(2)}`, cfg, signal, runId);

beforeEach(() => {
  resetKnightState();
  resetPlanLimits();
});

// ── config ─────────────────────────────────────────────────────────

test("subscription defaults to the cli runtime", () => {
  assert.equal(config.authMode, "subscription");
  assert.equal(config.runtime, "cli");
  assert.equal(config.claudeBin, FAKE);
  assert.equal(loadConfig({ ...env, CLAUDE_BIN: "" }).claudeBin, "claude");
});

// ── argument and file generation ───────────────────────────────────

test("builds a headless, unattended claude -p invocation", () => {
  const inv = buildCliInvocation({ ...config, effort: "high", maxTurns: 30, maxBudgetUsd: 2.5 }, {
    taskDir: "/tmp/task",
    resume: "11111111-2222-3333-4444-555555555555",
    selfCommand: ["/usr/local/bin/node", "/app/dist/index.js"],
    env: process.env,
  });
  const a = inv.args;
  assert.equal(inv.bin, FAKE);
  assert.equal(inv.cwd, work, "defaults to the root workdir");
  assert.deepEqual(a.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);
  assert.equal(flag(a, "--permission-mode"), "bypassPermissions");
  assert.ok(a.includes("--allow-dangerously-skip-permissions"));
  assert.equal(flag(a, "--append-system-prompt-file"), "/tmp/task/system-prompt.md");
  assert.equal(flag(a, "--mcp-config"), "/tmp/task/mcp.json");
  assert.equal(flag(a, "--settings"), "/tmp/task/settings.json");
  assert.equal(flag(a, "--setting-sources"), "user,project");
  assert.equal(flag(a, "--model"), "claude-sonnet-4-6");
  assert.equal(flag(a, "--effort"), "high");
  assert.equal(flag(a, "--max-turns"), "30");
  assert.equal(flag(a, "--max-budget-usd"), "2.5");
  assert.equal(flag(a, "--resume"), "11111111-2222-3333-4444-555555555555");
  assert.deepEqual(flag(a, "--disallowedTools")!.split(","), DISALLOWED_TOOLS);
  const allowed = flag(a, "--allowedTools")!.split(",");
  for (const t of ["Grep", "Glob", "WebFetch", "WebSearch", "mcp__roundtable__nats_request", "mcp__vault", "mcp__files"]) assert.ok(allowed.includes(t), t);
  // The prompt never goes on the command line.
  assert.ok(!a.some((x) => /brief me/.test(x)));
});

test("optional flags are left out when unset", () => {
  const inv = buildCliInvocation(loadConfig({ ...env, KNIGHT_MODEL: "openrouter/deepseek/deepseek-v3.2" }), { taskDir: "/t", selfCommand: ["node", "x.js"], env: {} });
  for (const f of ["--model", "--effort", "--max-turns", "--max-budget-usd", "--resume"]) assert.equal(inv.args.includes(f), false, f);
  const extra = buildCliInvocation(loadConfig({ ...env, CLAUDE_DISALLOWED_TOOLS: "WebSearch, Agent" }), { taskDir: "/t", selfCommand: ["node", "x.js"], env: {} });
  assert.deepEqual(flag(extra.args, "--disallowedTools")!.split(",").slice(-2), ["WebSearch", "Agent"]);
});

test("generates the MCP config, the guardrail hook settings and the system prompt", () => {
  const inv = buildCliInvocation(config, { taskDir: "/tmp/task", selfCommand: ["/usr/local/bin/node", "/app/dist/index.js"], env: process.env });
  const mcp = JSON.parse(inv.files["/tmp/task/mcp.json"]!);
  assert.deepEqual(mcp.mcpServers.roundtable, {
    type: "stdio",
    command: "/usr/local/bin/node",
    args: ["/app/dist/index.js", "mcp"],
    env: { KNIGHT_NAME: "Gawain", NATS_RESULTS_PREFIX: "rt.results", LOG_LEVEL: "info" },
    alwaysLoad: true,
  });
  assert.equal(mcp.mcpServers.vault.url, "http://from-env", "MCP_SERVERS_JSON wins over /config/mcp.json");
  assert.equal(mcp.mcpServers.files.command, "mcp-files");

  const settings = JSON.parse(inv.files["/tmp/task/settings.json"]!);
  assert.deepEqual(settings.hooks.PreToolUse, [
    { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/node /app/dist/index.js hook pretooluse", timeout: 30 }] },
  ]);
  assert.deepEqual(settings.attribution, { commit: "", pr: "" }, "no Claude co-author trailer or PR footer");

  const prompt = inv.files["/tmp/task/system-prompt.md"]!;
  assert.match(prompt, /You are Gawain, a Knight of the Round Table/);
  assert.match(prompt, /<knight_file name="SOUL.md">\nI am the soul of Gawain\./);
});

test("hook command lines are shell-quoted", () => {
  assert.equal(shellQuote(["/usr/bin/node", "/app/dist/index.js"]), "/usr/bin/node /app/dist/index.js");
  assert.equal(shellQuote(["/opt/my node/node", "it's"]), `'/opt/my node/node' 'it'\\''s'`);
});

test("subscription env: API credentials, gateway URL and SDK host markers are stripped", () => {
  const inv = buildCliInvocation(config, { taskDir: "/t", selfCommand: ["node", "x.js"], env: process.env });
  assert.equal(inv.env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-test");
  assert.equal(inv.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(inv.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(inv.env.CLAUDE_CODE_ENTRYPOINT, undefined);
  assert.equal(inv.env.CLAUDE_CONFIG_DIR, join(work, ".claude-home"));
  assert.equal(inv.env.DISABLE_AUTOUPDATER, "1");
  assert.equal(inv.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
});

test("egress injection env: placeholder bearer, OAuth beta header and gateway URL pass through", () => {
  const podEnv = {
    ANTHROPIC_AUTH_TOKEN: "placeholder-replaced-at-egress",
    ANTHROPIC_CUSTOM_HEADERS: "anthropic-beta: oauth-2025-04-20",
    ANTHROPIC_BASE_URL: "http://egress.invalid",
    ANTHROPIC_API_KEY: "sk-ant-api03-stray",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-unused",
  };
  const inv = buildCliInvocation(config, { taskDir: "/t", selfCommand: ["node", "x.js"], env: podEnv });
  assert.equal(inv.env.ANTHROPIC_AUTH_TOKEN, "placeholder-replaced-at-egress");
  assert.equal(inv.env.ANTHROPIC_CUSTOM_HEADERS, "anthropic-beta: oauth-2025-04-20");
  assert.equal(inv.env.ANTHROPIC_BASE_URL, "http://egress.invalid");
  assert.equal(inv.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(inv.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

// ── stream-json parsing ────────────────────────────────────────────

test("parseStreamLine accepts messages and ignores noise", () => {
  assert.equal(parseStreamLine('{"type":"result","subtype":"success"}')?.type, "result");
  assert.equal(parseStreamLine("Warning: something"), undefined);
  assert.equal(parseStreamLine('{"no":"type"}'), undefined);
  assert.equal(parseStreamLine("{broken"), undefined);
  assert.equal(parseStreamLine(""), undefined);
});

test("success: result text, cost, tokens, turns, model and session id", async () => {
  useFixture("success");
  const r = await run("brief me");
  assert.equal(r.success, true, r.error);
  assert.equal(r.result, "pong");
  assert.equal(r.billing, "subscription");
  assert.equal(r.turns, 1);
  assert.ok(r.cost > 0);
  assert.equal(r.tokens.input, 100);
  assert.equal(r.tokens.output, 20);
  assert.match(r.model, /^claude-sonnet/);
  const sid = readFileSync(fixture("success"), "utf8").split("\n")[0]!.match(/"session_id":"([^"]+)"/)![1];
  assert.equal(getRecentTasks().at(-1)!.sessionId, sid);

  const call = lastCall();
  assert.equal(call.stdin, "brief me", "prompt goes in on stdin");
  assert.ok(call.cwd.startsWith(join(work, "work") + "/t-"), "runs in a per-task directory");
  assert.match(call.cwd, /\/work\/t-[a-z0-9]+$/);
  assert.match(call.files.systemPrompt!, /Working directory for this task: .*\/work\/t-/);
  assert.equal(call.env.ANTHROPIC_API_KEY, undefined);
  assert.match(call.files.systemPrompt!, /You are Gawain/);
  assert.ok(JSON.parse(call.files.mcp!).mcpServers.roundtable);
  assert.ok(JSON.parse(call.files.settings!).hooks.PreToolUse);
  assert.deepEqual(readdirSync(tasksTmp), [], "per-task files are removed afterwards");
});

test("tool use: final text after the tool round trip, tool calls counted", async () => {
  useFixture("tool-use");
  const r = await run("RUN_BASH: echo hello-from-bash");
  assert.equal(r.success, true, r.error);
  assert.equal(r.result, "TOOL_RESULT: hello-from-bash");
  assert.equal(r.turns, 2);
  const m = await registry.getSingleMetricAsString("claude_knight_tool_calls_total");
  assert.match(m, /tool="Bash",status="success"\} 1/);
});

test("usage limit: fast-fail with usage_limited and the reset time; plan reserve blocks", async () => {
  useFixture("usage-limit");
  const r = await run("x");
  assert.equal(r.success, false);
  assert.equal(r.usageLimited, true);
  assert.match(r.error!, /usage limit reached: You've hit your limit · resets 3am/);
  assert.match(checkReserve(0.8).reason!, /seven_day window 91% used .*resets 2100-01-01/);
  // With the reserve disabled, the rejected window still blocks until it resets.
  assert.match(checkReserve(1).reason!, /five_hour limit reached \(resets 2100-01-01T00:00:00\.000Z\)/);
  assert.equal(checkReserve(1, Date.UTC(2100, 0, 1, 0, 0, 1)).blocked, false);
});

test("error: an auth failure is reported as such", async () => {
  useFixture("auth-error", { exit: 1 });
  const r = await run("x");
  assert.equal(r.success, false);
  assert.match(r.error!, /Claude authentication failed \(authentication_failed\).*CLAUDE_CODE_OAUTH_TOKEN/);
});

test("API-key auth in subscription mode aborts the run", async () => {
  useFixture("api-key-auth");
  const r = await run("x");
  assert.equal(r.success, false);
  assert.match(r.error!, /Refusing to run: subscription mode but Claude Code authenticated via ANTHROPIC_API_KEY/);
});

test("API-key auth is fine in api mode", async () => {
  useFixture("api-key-auth", { exit: 1 });
  const r = await run("x", undefined, { ...config, authMode: "api" });
  assert.doesNotMatch(r.error ?? "", /Refusing/);
  assert.match(r.error!, /authentication failed/);
});

test("a crash without a result message surfaces the exit code and stderr", async () => {
  useFixture("success", { exit: 3, stderr: "boom: something broke\n" });
  process.env.FAKE_CLAUDE_FIXTURE = initOnlyFixture(); // no result message arrives
  const r = await run("x");
  assert.equal(r.success, false);
  assert.match(r.error!, /exited with code 3: boom: something broke/);
});

test("a missing CLI binary is a clear failure", async () => {
  const r = await run("x", undefined, { ...config, claudeBin: join(root, "no-such-claude") });
  assert.equal(r.success, false);
  assert.match(r.error!, /Could not start the Claude Code CLI .*ENOENT/);
});

function initOnlyFixture(): string {
  const file = join(root, "init-only.jsonl");
  writeFileSync(file, readFileSync(fixture("success"), "utf8").split("\n")[0] + "\n");
  return file;
}

test("abort (task timeout) kills the process and reports a timeout", async () => {
  useFixture("success", { hang: true });
  process.env.FAKE_CLAUDE_FIXTURE = initOnlyFixture();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  const started = Date.now();
  const r = await run("x", undefined, config, ac.signal);
  assert.ok(Date.now() - started < 5000, "killed promptly");
  assert.equal(r.success, false);
  assert.match(r.error!, /aborted before producing output \(task timeout\)/);
});

test("chain steps resume one session; fresh mode never resumes", async () => {
  useFixture("success");
  await run("step 1", "run-A");
  assert.equal(flag(lastCall().argv, "--resume"), undefined);
  await run("step 2", "run-A");
  const sid = readFileSync(fixture("success"), "utf8").match(/"session_id":"([^"]+)"/)![1];
  assert.equal(flag(lastCall().argv, "--resume"), sid);
  await run("other", "run-B");
  assert.equal(flag(lastCall().argv, "--resume"), undefined);

  const fresh = loadConfig({ ...env, CLAUDE_SESSION_MODE: "fresh" });
  await run("s1", "run-C", fresh);
  await run("s2", "run-C", fresh);
  assert.equal(flag(lastCall().argv, "--resume"), undefined);
});

test("concurrent tasks get distinct working directories, removed afterwards", async () => {
  useFixture("success");
  const seen: string[] = [];
  const over = { cliInvocation: (inv: CliInvocation) => (seen.push(inv.cwd), assert.ok(existsSync(inv.cwd), "created before spawn"), inv) };
  const go = (id: string, runId?: string) => executeTask("x", id, config, new AbortController().signal, runId, over);
  await Promise.all([go("a1"), go("b/../2"), go("c3", "run-X")]);
  assert.equal(new Set(seen).size, 3);
  for (const d of seen) {
    assert.equal(join(d, ".."), join(work, "work"), "stays under $KNIGHT_WORKDIR/work");
    assert.ok(!existsSync(d), "removed after the task");
  }
  assert.equal(seen[2], join(work, "work", "run-X"), "keyed on runId when present");
  // the same runId reuses the same directory (session resume is per cwd)
  await go("c4", "run-X");
  assert.equal(seen[3], seen[2]);
});

test("the knight's root CLAUDE.md and .claude/ are visible from the per-task cwd", async () => {
  useFixture("success");
  writeFileSync(join(work, "CLAUDE.md"), "root rules");
  mkdirSync(join(work, ".claude"), { recursive: true });
  writeFileSync(join(work, ".claude", "settings.json"), "{}");
  try {
    let md = "", st = "";
    const over = { cliInvocation: (inv: CliInvocation) => (md = readFileSync(join(inv.cwd, "CLAUDE.md"), "utf8"), st = readFileSync(join(inv.cwd, ".claude", "settings.json"), "utf8"), inv) };
    await executeTask("x", "link1", config, new AbortController().signal, undefined, over);
    assert.equal(md, "root rules");
    assert.equal(st, "{}");
    assert.ok(existsSync(join(work, "CLAUDE.md")) && existsSync(join(work, ".claude", "settings.json")), "removing the task dir leaves the root config intact");
  } finally {
    rmSync(join(work, "CLAUDE.md"));
    rmSync(join(work, ".claude"), { recursive: true });
  }
});

test("a failed task's directory is kept only when DEBUG is set", async () => {
  useFixture("auth-error");
  const dirs: string[] = [];
  const over = { cliInvocation: (inv: CliInvocation) => (dirs.push(inv.cwd), inv) };
  const fail = () => executeTask("x", `f-${dirs.length}`, config, new AbortController().signal, undefined, over);
  assert.equal((await fail()).success, false);
  assert.ok(!existsSync(dirs[0]!));
  process.env.DEBUG = "1";
  try {
    assert.equal((await fail()).success, false);
    assert.ok(existsSync(dirs[1]!));
  } finally {
    delete process.env.DEBUG;
  }
});

test("startup refuses subscription + sdk", async () => {
  const { checkRuntime } = await import("../src/auth.js");
  assert.match(checkRuntime("subscription", "sdk")!, /only be used with the official Claude Code CLI/);
  assert.equal(checkRuntime("subscription", "cli"), undefined);
  assert.equal(checkRuntime("api", "sdk"), undefined);
  assert.equal(checkRuntime("api", "cli"), undefined);
  assert.ok(existsSync(FAKE));
});
