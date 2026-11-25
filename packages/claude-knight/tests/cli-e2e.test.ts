/**
 * The cli runtime end to end with the REAL Claude Code binary (the pinned one
 * the Agent SDK's platform package ships, byte-identical to
 * @anthropic-ai/claude-code-linux-x64) against a scripted mock of the Messages
 * API, so no credential is needed. It exercises what unit tests cannot: the
 * flags the CLI accepts, the stdio MCP server Claude Code spawns from the
 * generated --mcp-config, the PreToolUse command hook from the generated
 * settings.json, session resume, and introspect over the CLI's transcripts.
 *
 * Runs in api mode (a fake API key) because subscription mode strips
 * ANTHROPIC_BASE_URL, which the mock needs. Skipped when the binary is missing
 * or CK_SKIP_CLI_E2E=1.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadConfig, type KnightConfig } from "../src/config.js";
import { executeTask, resetKnightState, type ExecuteOverrides } from "../src/knight.js";
import { handleIntrospect as coreIntrospect, type IntrospectRequest } from "@roundtable/knight-core";
import { introspectOptions } from "../src/session-source.js";
const handleIntrospect = (req: IntrospectRequest, cfg: KnightConfig) => coreIntrospect(req, introspectOptions(cfg));
import { registry } from "../src/runtime-metrics.js";
import { startMockAnthropic, type MockAnthropic } from "./helpers/mock-anthropic.js";

function bundledClaude(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const bin = join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json")), "claude");
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

const BIN = process.env.CK_CLAUDE_BIN || bundledClaude();
const skip = process.env.CK_SKIP_CLI_E2E === "1" ? "CK_SKIP_CLI_E2E=1" : !BIN ? "Claude Code binary not installed" : false;

let mock: MockAnthropic;
let config: KnightConfig;
let home: string;
let over: ExecuteOverrides;

before(async () => {
  if (skip) return;
  mock = await startMockAnthropic();
  home = mkdtempSync(join(tmpdir(), "ck-e2e-"));
  const work = join(home, "data");
  mkdirSync(join(work, ".claude-home"), { recursive: true });
  writeFileSync(join(work, ".claude-home", ".claude.json"), '{"hasCompletedOnboarding":true}');
  config = loadConfig({
    KNIGHT_NAME: "Gawain",
    SUBSCRIBE_TOPICS: "rt.tasks.security.>",
    KNIGHT_MODEL: "sonnet",
    KNIGHT_WORKDIR: work,
    KNIGHT_SKILLS_DIR: join(home, "skills"),
    KNIGHT_CONFIG_DIR: join(home, "config"),
    CLAUDE_AUTH_MODE: "api",
    CLAUDE_RUNTIME: "cli",
    CLAUDE_BIN: BIN!,
  });
  // A clean environment: nothing from the developer's own Claude Code setup.
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    ANTHROPIC_API_KEY: "sk-ant-api03-fake-e2e",
    ANTHROPIC_BASE_URL: mock.url,
    NATS_URL: "nats://127.0.0.1:1", // nothing listens: nats tools must say so, not hang
    BROWSER_ENABLED: "true", // inherited by the MCP server through Claude Code's env
  };
  over = { cliInvocation: (inv) => ({ ...inv, env: { ...env, ...pick(inv.env, ["CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]) } }) };
  resetKnightState();
});

after(async () => {
  await mock?.close();
});

function pick(env: Record<string, string | undefined>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((k) => env[k] != null).map((k) => [k, env[k]!]));
}

const run = (task: string, runId?: string, cfg?: Partial<KnightConfig>) =>
  executeTask(task, `t-${Date.now()}`, { ...config, ...cfg }, new AbortController().signal, runId, over);

test("real claude -p: system prompt, model and tool set", { skip, timeout: 120_000 }, async () => {
  const sys = await run("ECHO_SYSTEM <runtime_context>");
  assert.equal(sys.success, true, sys.error);
  assert.equal(sys.result, "system-has-marker: yes");
  assert.ok(sys.turns >= 1);
  assert.ok(sys.tokens.input > 0 && sys.tokens.output > 0);
  const firstMessages = mock.requests.find((r) => r.path === "/v1/messages")!;
  assert.match(firstMessages.body.model, /sonnet/);

  const r = await run("LIST_TOOLS");
  assert.equal(r.success, true, r.error);
  const tools = r.result.replace(/^TOOLS: /, "").split(",");
  for (const t of ["Bash", "mcp__roundtable__nats_request", "mcp__roundtable__nats_publish", "mcp__roundtable__browser_snapshot"]) {
    assert.ok(tools.includes(t), `${t} offered (got ${tools.join(" ")})`);
  }
  for (const t of ["AskUserQuestion", "CronCreate", "EnterPlanMode"]) assert.ok(!tools.includes(t), `${t} disallowed`);
});

test("real claude -p: Round Table tools over the stdio MCP server", { skip, timeout: 120_000 }, async () => {
  const r = await run('CALL_TOOL: mcp__roundtable__nats_publish {"subject":"rt.alerts.test","message":"hi"}');
  assert.equal(r.success, true, r.error);
  assert.match(r.result, /^TOOL_RESULT \(error\): .*NATS not connected/);
});

test("real claude -p: Bash runs, and the guardrail hook denies blocked commands", { skip, timeout: 120_000 }, async () => {
  const ok = await run("RUN_BASH: echo hello-from-bash");
  assert.equal(ok.success, true, ok.error);
  assert.equal(ok.result, "TOOL_RESULT: hello-from-bash");

  const blocked = await run("RUN_BASH: chmod 777 /tmp/ck-e2e-never");
  assert.equal(blocked.success, true, blocked.error);
  assert.match(blocked.result, /TOOL_RESULT \(error\): .*Blocked by knight safety policy: World-writable permissions/);
  const metrics = await registry.getSingleMetricAsString("roundtable_knight_tool_calls_blocked_total");
  assert.match(metrics, /tool="Bash",reason="World-writable permissions",table="none",knight="[^"]*",runtime="claude"\} 1/);
});

test("real claude -p: chain steps resume one session; introspect reads the transcripts", { skip, timeout: 120_000 }, async () => {
  const before = mock.requests.length;
  const a = await run("first step", "run-e2e");
  const b = await run("ECHO_SYSTEM <runtime_context>", "run-e2e");
  assert.equal(a.success && b.success, true);
  // The resumed request carries the first step's conversation.
  const resumed = mock.requests.slice(before).filter((r) => r.path === "/v1/messages").at(-1)!;
  const userTexts = JSON.stringify(resumed.body.messages);
  assert.match(userTexts, /first step/);

  const history: any = await handleIntrospect({ type: "history" }, config);
  assert.ok(history.sessions.length >= 1);
  const latest = history.sessions[0];
  assert.match(latest.firstPrompt, /first step/);
  const session: any = await handleIntrospect({ type: "session", id: latest.id }, config);
  assert.ok(session.total >= 4, `user+assistant ×2, got ${session.total}`);
  assert.ok(session.entries.some((e: any) => e.role === "assistant" && /system-has-marker/.test(e.text ?? "")));
});

test("real claude -p: the turn cap ends the task as a turn-limit failure", { skip, timeout: 120_000 }, async () => {
  const r = await run("RUN_BASH: echo capped", undefined, { maxTurns: 1 });
  assert.equal(r.success, false);
  assert.match(r.error!, /turn limit/);
});
