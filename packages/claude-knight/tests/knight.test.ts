/**
 * executeTask against a fake Claude Code stream: options passed to the SDK,
 * session resume within a chain run, subscription-mode safety, and limits.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { DISALLOWED_TOOLS, executeTask, resetKnightState, type QueryFn } from "../src/knight.js";
import { checkReserve, resetPlanLimits } from "../src/plan-limits.js";

const work = mkdtempSync(join(tmpdir(), "ck-work-"));
process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-test";
process.env.ANTHROPIC_API_KEY = "sk-ant-api03-should-be-stripped";

const config = loadConfig({
  KNIGHT_NAME: "Gawain",
  SUBSCRIBE_TOPICS: "rt.tasks.security.>",
  KNIGHT_MODEL: "openrouter/deepseek/deepseek-v3.2",
  KNIGHT_WORKDIR: work,
  KNIGHT_SKILLS_DIR: join(work, "skills"),
  KNIGHT_CONFIG_DIR: join(work, "config"),
  MCP_SERVERS_JSON: JSON.stringify({ mcpServers: { vault: { type: "http", url: "http://mcpvault:8080/mcp" } } }),
});

interface Call {
  prompt: unknown;
  options: any;
}

function fakeQuery(script: (call: Call, n: number) => any[]): { fn: QueryFn; calls: Call[] } {
  const calls: Call[] = [];
  const fn = ((params: Call) => {
    calls.push(params);
    const msgs = script(params, calls.length);
    return (async function* () {
      for (const m of msgs) {
        if (m instanceof Error) throw m;
        yield m;
      }
    })();
  }) as unknown as QueryFn;
  return { fn, calls };
}

const init = (sid: string, apiKeySource = "oauth") => ({
  type: "system",
  subtype: "init",
  session_id: sid,
  apiKeySource,
  model: "claude-sonnet-4-6",
  claude_code_version: "2.x",
  mcp_servers: [],
  skills: [],
});
const done = (sid: string, text: string) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 2,
  result: text,
  total_cost_usd: 0.01,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: { "claude-sonnet-4-6": { outputTokens: 5 } },
  session_id: sid,
});

beforeEach(() => {
  resetKnightState();
  resetPlanLimits();
});

test("passes an unattended, subscription-only configuration to Claude Code", async () => {
  const { fn, calls } = fakeQuery(() => [init("s1"), done("s1", "ok")]);
  const r = await executeTask("brief me", "t1", config, new AbortController().signal, undefined, fn);
  assert.equal(r.success, true);

  const o = calls[0]!.options;
  assert.equal(calls[0]!.prompt, "brief me");
  assert.equal(o.cwd, work);
  assert.equal(o.model, undefined, "non-Claude spec.model falls back to Claude Code default");
  assert.equal(o.permissionMode, "bypassPermissions");
  assert.equal(o.allowDangerouslySkipPermissions, true);
  for (const t of ["AskUserQuestion", "EnterPlanMode", "CronCreate"]) assert.ok(o.disallowedTools.includes(t));
  assert.deepEqual(o.disallowedTools.slice(0, DISALLOWED_TOOLS.length), DISALLOWED_TOOLS);
  assert.ok(o.mcpServers.roundtable, "built-in NATS tools server");
  assert.equal(o.mcpServers.vault.url, "http://mcpvault:8080/mcp");
  assert.ok(o.allowedTools.includes("mcp__vault"));
  assert.equal(o.systemPrompt.preset, "claude_code");
  assert.match(o.systemPrompt.append, /You are Gawain, a Knight of the Round Table/);
  assert.equal(o.env.ANTHROPIC_API_KEY, undefined, "API key stripped in subscription mode");
  assert.equal(o.env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-test");
  assert.equal(o.env.CLAUDE_CONFIG_DIR, join(work, ".claude-home"));
  assert.equal(o.resume, undefined);
  assert.ok(o.hooks.PreToolUse);
});

test("tasks in the same chain run resume one session; a new run starts fresh", async () => {
  const { fn, calls } = fakeQuery((_c, n) => [init(`s${n}`), done(`s${n}`, `step ${n}`)]);
  const sig = new AbortController().signal;
  await executeTask("step 1", "a", config, sig, "run-A", fn);
  await executeTask("step 2", "b", config, sig, "run-A", fn);
  await executeTask("other", "c", config, sig, "run-B", fn);
  await executeTask("ad hoc", "d", config, sig, undefined, fn);
  assert.equal(calls[0]!.options.resume, undefined);
  assert.equal(calls[1]!.options.resume, "s1");
  assert.equal(calls[2]!.options.resume, undefined);
  assert.equal(calls[3]!.options.resume, undefined);
});

test("concurrent tasks of one run are serialized so resume sees the prior session", async () => {
  let active = 0;
  let maxActive = 0;
  const calls: any[] = [];
  const fn = ((params: any) => {
    calls.push(params);
    const n = calls.length;
    return (async function* () {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      yield init(`s${n}`);
      yield done(`s${n}`, "x");
      active--;
    })();
  }) as unknown as QueryFn;
  const sig = new AbortController().signal;
  await Promise.all([
    executeTask("1", "a", config, sig, "run-C", fn),
    executeTask("2", "b", config, sig, "run-C", fn),
  ]);
  assert.equal(maxActive, 1);
  assert.equal(calls[1].options.resume, "s1");
});

test("refuses to run if Claude Code reports API-key auth in subscription mode", async () => {
  const { fn } = fakeQuery(() => [init("s1", "ANTHROPIC_API_KEY"), done("s1", "should not count")]);
  const r = await executeTask("x", "t", config, new AbortController().signal, undefined, fn);
  assert.equal(r.success, false);
  assert.match(r.error!, /Refusing to run: subscription mode/);
});

test("rate-limit events feed the plan reserve; limit errors are flagged", async () => {
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  const { fn } = fakeQuery(() => [
    init("s1"),
    { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.91, resetsAt }, session_id: "s1" },
    { ...done("s1", "You've hit your limit · resets Mon 9am"), is_error: true },
  ]);
  const r = await executeTask("x", "t", config, new AbortController().signal, undefined, fn);
  assert.equal(r.success, false);
  assert.equal(r.usageLimited, true);
  assert.equal(checkReserve(0.8).blocked, true);
});

test("a thrown SDK error and an abort both produce failure results, not exceptions", async () => {
  const { fn } = fakeQuery(() => [init("s1"), new Error("Claude Code process exited with code 1")]);
  const r = await executeTask("x", "t", config, new AbortController().signal, undefined, fn);
  assert.equal(r.success, false);
  assert.match(r.error!, /exited with code 1/);

  const ac = new AbortController();
  const slow = fakeQuery(() => [
    init("s2"),
    { type: "assistant", parent_tool_use_id: null, session_id: "s2", message: { content: [{ type: "text", text: "partial" }] } },
    new Error("aborted"),
  ]);
  ac.abort();
  const t = await executeTask("x", "t2", config, ac.signal, undefined, slow.fn);
  assert.equal(t.success, false);
  assert.match(t.error!, /timed out.*partial/s);
});

test("cost of a resumed task is the delta over the session's prior cumulative cost", async () => {
  const totals = [0.01, 0.03];
  const { fn } = fakeQuery((_c, n) => [init("s1"), { ...done("s1", "x"), total_cost_usd: totals[n - 1] }]);
  const sig = new AbortController().signal;
  const a = await executeTask("1", "a", config, sig, "run-D", fn);
  const b = await executeTask("2", "b", config, sig, "run-D", fn);
  assert.equal(a.cost, 0.01);
  assert.ok(Math.abs(b.cost - 0.02) < 1e-9, `expected 0.02, got ${b.cost}`);
});

test("built-in NATS tools are always loaded, search tools requested", async () => {
  const { fn, calls } = fakeQuery(() => [init("s1"), done("s1", "ok")]);
  await executeTask("x", "t", config, new AbortController().signal, undefined, fn);
  const o = calls[0]!.options;
  assert.equal(o.mcpServers.roundtable.type, "sdk");
  for (const t of ["Grep", "Glob", "WebFetch", "WebSearch", "mcp__roundtable__nats_request"]) assert.ok(o.allowedTools.includes(t), t);
});
