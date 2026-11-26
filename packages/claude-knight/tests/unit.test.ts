import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readlinkSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, resolveClaudeModel } from "../src/config.js";
import { buildChildEnv, checkAuth } from "../src/auth.js";
import { claudeCodeTelemetryEnv } from "../src/telemetry-env.js";
import { checkBashCommand } from "../src/hooks.js";
import { discoverSkills, linkSkills } from "../src/skills.js";
import { checkReserve, normalizeEpochMs, normalizeUtilization, recordRateLimit, resetPlanLimits } from "../src/plan-limits.js";
import { classifyResult, isUsageLimitMessage } from "../src/result.js";
import { formatRequestResponse } from "@roundtable/knight-core";
import { taskWorkDir } from "../src/knight.js";
import { itemsForMessage } from "../src/session-source.js";

const baseEnv = { KNIGHT_NAME: "Gawain", SUBSCRIBE_TOPICS: "rt.tasks.security.>" };

// ── config ─────────────────────────────────────────────────────────

test("model mapping accepts Claude ids and aliases, drops non-Claude models", () => {
  assert.equal(resolveClaudeModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(resolveClaudeModel("anthropic/claude-sonnet-4.6"), "claude-sonnet-4-6");
  assert.equal(resolveClaudeModel("openrouter/anthropic/claude-opus-4.6"), "claude-opus-4-6");
  assert.equal(resolveClaudeModel("Sonnet"), "sonnet");
  assert.equal(resolveClaudeModel("opus[1m]"), "opus[1m]");
  // the CRD default must not reach Claude Code
  assert.equal(resolveClaudeModel("openrouter/deepseek/deepseek-v3.2"), undefined);
  assert.equal(resolveClaudeModel(""), undefined);
  // CLAUDE_MODEL overrides spec.model
  assert.equal(resolveClaudeModel("openrouter/deepseek/deepseek-v3.2", "haiku"), "haiku");
});

test("DRAIN_TIMEOUT_MS defaults to TASK_TIMEOUT_MS + 60s", () => {
  assert.equal(loadConfig({ ...baseEnv }).drainTimeoutMs, 1_800_000 + 60_000);
  assert.equal(loadConfig({ ...baseEnv, TASK_TIMEOUT_MS: "1000" }).drainTimeoutMs, 61_000);
  assert.equal(loadConfig({ ...baseEnv, TASK_TIMEOUT_MS: "1000", DRAIN_TIMEOUT_MS: "5" }).drainTimeoutMs, 5);
});

test("taskWorkDir is collision-safe and stable", () => {
  const c = loadConfig({ ...baseEnv });
  assert.notEqual(taskWorkDir(c, "t", "a/b"), taskWorkDir(c, "t", "a_b"));
  assert.equal(taskWorkDir(c, "t", "a/b"), taskWorkDir(c, "other", "a/b"));
  assert.equal(taskWorkDir(c, "t1"), taskWorkDir(c, "t1"));
  assert.ok(taskWorkDir(c, "x".repeat(300)).split("/").pop()!.length <= 120);
});

test("loadConfig defaults and validation", () => {
  const c = loadConfig({ ...baseEnv });
  assert.equal(c.authMode, "subscription");
  assert.equal(c.sessionMode, "run");
  assert.equal(c.claudeConfigDir, "/data/.claude-home");
  assert.equal(c.planReserve, 0.8);
  assert.deepEqual(c.subscribeTopics, ["rt.tasks.security.>"]);
  assert.throws(() => loadConfig({ ...baseEnv, CLAUDE_AUTH_MODE: "max" }), /CLAUDE_AUTH_MODE/);
  assert.throws(() => loadConfig({ SUBSCRIBE_TOPICS: "x" }), /KNIGHT_NAME/);
  assert.equal(loadConfig({ ...baseEnv, CLAUDE_PLAN_RESERVE: "5" }).planReserve, 1);
  // runtime: cli for subscription, sdk for api, overridable, validated
  assert.equal(c.runtime, "cli");
  assert.equal(loadConfig({ ...baseEnv, CLAUDE_AUTH_MODE: "api" }).runtime, "sdk");
  assert.equal(loadConfig({ ...baseEnv, CLAUDE_AUTH_MODE: "api", CLAUDE_RUNTIME: "CLI" }).runtime, "cli");
  assert.throws(() => loadConfig({ ...baseEnv, CLAUDE_RUNTIME: "docker" }), /CLAUDE_RUNTIME/);
});

// ── auth ───────────────────────────────────────────────────────────

test("subscription mode requires the OAuth token and strips API credentials", () => {
  const missing = checkAuth("subscription", { ANTHROPIC_API_KEY: "sk-ant-api03-x" });
  assert.equal(missing.ok, false);
  assert.match(missing.reason!, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(missing.warnings[0]!, /ANTHROPIC_API_KEY/);

  const env = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc", ANTHROPIC_API_KEY: "sk-ant-api03-x", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "http://gw", PATH: "/bin" };
  assert.equal(checkAuth("subscription", env).ok, true);
  const child = buildChildEnv("subscription", { CLAUDE_CONFIG_DIR: "/data/.claude-home" }, env);
  assert.equal(child.ANTHROPIC_API_KEY, undefined);
  assert.equal(child.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(child.ANTHROPIC_BASE_URL, undefined);
  assert.equal(child.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-abc");
  assert.equal(child.PATH, "/bin");
  assert.equal(child.CLAUDE_CONFIG_DIR, "/data/.claude-home");
});

test("api mode requires an API key and strips the OAuth token", () => {
  assert.equal(checkAuth("api", { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc" }).ok, false);
  const env = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc", ANTHROPIC_API_KEY: "sk-ant-api03-x", ANTHROPIC_BASE_URL: "http://tensorzero" };
  assert.equal(checkAuth("api", env).ok, true);
  const child = buildChildEnv("api", {}, env);
  assert.equal(child.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(child.ANTHROPIC_API_KEY, "sk-ant-api03-x");
  assert.equal(child.ANTHROPIC_BASE_URL, "http://tensorzero"); // gateways are fine with API keys
});

test("the Claude Code child env carries no production-mode switches", () => {
  const env = { NODE_ENV: "production", npm_config_omit: "dev", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc", PATH: "/bin" };
  for (const mode of ["subscription", "api"] as const) {
    const child = buildChildEnv(mode, {}, env);
    assert.equal(child.NODE_ENV, undefined);
    assert.equal(child.npm_config_omit, undefined);
    assert.equal(child.PATH, "/bin");
  }
});

test("no OTLP endpoint: the child gets no Claude Code telemetry switches", () => {
  assert.deepEqual(claudeCodeTelemetryEnv({ PATH: "/bin" }), {});
  const child = buildChildEnv("api", {}, { ANTHROPIC_API_KEY: "k", PATH: "/bin" });
  assert.equal(child["CLAUDE_CODE_ENABLE_TELEMETRY"], undefined);
  assert.equal(child["OTEL_LOG_USER_PROMPTS"], undefined);
});

test("OTLP endpoint switches on Claude Code's export with content on", () => {
  const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" };
  const t = claudeCodeTelemetryEnv(env);
  assert.deepEqual(t, {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
    OTEL_TRACES_EXPORTER: "otlp",
    OTEL_METRICS_EXPORTER: "otlp",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_SERVICE_NAME: "claude-knight",
    OTEL_LOG_USER_PROMPTS: "1",
    OTEL_LOG_ASSISTANT_RESPONSES: "1",
    OTEL_LOG_TOOL_DETAILS: "1",
    OTEL_LOG_TOOL_CONTENT: "1",
  });
  assert.equal(claudeCodeTelemetryEnv({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c/v1/traces" }).OTEL_TRACES_EXPORTER, "otlp");
  assert.deepEqual(claudeCodeTelemetryEnv({ ...env, OTEL_SDK_DISABLED: "true" }), {});
  assert.ok(!("OTEL_LOG_RAW_API_BODIES" in t));
  const child = buildChildEnv("api", {}, { ...env, ANTHROPIC_API_KEY: "k" });
  assert.equal(child["CLAUDE_CODE_ENABLE_TELEMETRY"], "1");
  assert.equal(child["OTEL_LOG_TOOL_CONTENT"], "1");
});

test("ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT=false turns the content flags off", () => {
  const t = claudeCodeTelemetryEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c", ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT: "false" });
  assert.equal(t.CLAUDE_CODE_ENABLE_TELEMETRY, "1");
  assert.equal(t.OTEL_LOG_USER_PROMPTS, "0");
  assert.equal(t.OTEL_LOG_ASSISTANT_RESPONSES, "0");
  assert.equal(t.OTEL_LOG_TOOL_DETAILS, "0");
  assert.equal(t.OTEL_LOG_TOOL_CONTENT, "0");
});

test("explicit pod values win over the Claude Code telemetry defaults", () => {
  const env = {
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://c",
    OTEL_LOG_USER_PROMPTS: "0",
    OTEL_SERVICE_NAME: "custom",
    OTEL_METRICS_EXPORTER: "prometheus",
  };
  const t = claudeCodeTelemetryEnv(env);
  assert.equal(t.OTEL_LOG_USER_PROMPTS, undefined);
  assert.equal(t.OTEL_SERVICE_NAME, undefined);
  assert.equal(t.OTEL_METRICS_EXPORTER, undefined);
  assert.equal(t.OTEL_LOG_ASSISTANT_RESPONSES, "1");
  const child = buildChildEnv("api", {}, { ...env, ANTHROPIC_API_KEY: "k" });
  assert.equal(child["OTEL_LOG_USER_PROMPTS"], "0");
  assert.equal(child["OTEL_METRICS_EXPORTER"], "prometheus");
});

// ── hooks ──────────────────────────────────────────────────────────

test("bash guardrails block the commands listed in src/guardrails.ts", () => {
  for (const cmd of [
    "rm -rf /",
    "rm -rf / --no-preserve-root",
    "rm -fr /*",
    "git push origin main --force",
    "git push -f origin main",
    "chmod 777 file",
    "chmod -R 777 /data",
    "git push --force origin main",
    "git push -fu origin main",
    "dd if=/dev/zero of=/dev/sda",
    "mkfs.ext4 /dev/sdb",
  ]) {
    assert.ok(checkBashCommand(cmd), `expected block: ${cmd}`);
  }
  for (const cmd of [
    "rm -rf /data/scratch/tmp",
    "rm -rf ./build",
    "git push --force-with-lease origin feature",
    "git push origin feature",
    "curl -fsSL https://api.example.com | jq .",
    "curl -fsSL https://x.sh | sh", // remote-script piping is no longer blocked
    "wget -qO- https://x | sudo sh",
    "git push origin fix-f", // branch name ending in -f is not the flag
    "git push origin feature-f && ls -f",
    "git push --force-if-includes --force-with-lease origin br",
    "git commit -m 'never git push -f'; ls",
    "chmod 755 script.sh",
  ]) {
    assert.equal(checkBashCommand(cmd), undefined, `expected allow: ${cmd}`);
  }
});

// ── skills ─────────────────────────────────────────────────────────

function skillTree(): { skills: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), "ck-skills-"));
  const arsenal = join(root, "arsenal");
  const mk = (cat: string, skill: string) => {
    mkdirSync(join(arsenal, cat, skill), { recursive: true });
    writeFileSync(join(arsenal, cat, skill, "SKILL.md"), `---\nname: ${skill}\n---\n`);
  };
  mk("security", "morning-security-brief");
  mk("shared", "report-generator");
  mk("pentest", "report-generator");
  mkdirSync(join(arsenal, "shared", "config")); // dir without SKILL.md
  writeFileSync(join(arsenal, "shared", "notes.md"), "not a skill");
  // the skill-filter sidecar symlinks categories into /skills
  const skills = join(root, "skills");
  mkdirSync(skills);
  for (const cat of ["security", "shared", "pentest"]) symlinkSync(join(arsenal, cat), join(skills, cat));
  return { skills, config: join(root, "claude") };
}

test("skills are discovered two levels deep with collisions namespaced", () => {
  const { skills } = skillTree();
  const names = discoverSkills(skills).map((s) => s.name).sort();
  assert.deepEqual(names, ["morning-security-brief", "report-generator", "shared-report-generator"]);
});

test("linkSkills links, is idempotent, removes stale links, keeps the knight's own skills", () => {
  const { skills, config } = skillTree();
  const first = linkSkills(skills, config);
  assert.equal(first.added, 3);
  const target = join(config, "skills");
  assert.equal(readlinkSync(join(target, "report-generator")), join(skills, "pentest", "report-generator"));

  // knight-authored skill (a real dir) must survive
  mkdirSync(join(target, "my-own-skill"));
  writeFileSync(join(target, "my-own-skill", "SKILL.md"), "x");

  assert.deepEqual(linkSkills(skills, config), { names: first.names, added: 0, removed: 0 });

  // category removed from spec.skills → its links go away
  rmSync(join(skills, "security"));
  const after = linkSkills(skills, config);
  assert.equal(after.removed, 1);
  assert.ok(!existsSync(join(target, "morning-security-brief")));
  assert.ok(readdirSync(target).includes("my-own-skill"));
});

test("missing skills dir is not an error", () => {
  assert.deepEqual(discoverSkills("/nonexistent/skills"), []);
});

test("nats_request formats knight responses", () => {
  const ok = formatRequestResponse("galahad", JSON.stringify({ success: true, result: "all clear", cost: 0.0123, duration_ms: 4200 }));
  assert.match(ok.text, /Response from galahad \(4s, \$0\.0123\):\n\nall clear/);
  assert.equal(ok.ok, true);
  const bad = formatRequestResponse("galahad", JSON.stringify({ success: false, error: "boom" }));
  assert.equal(bad.ok, false);
  assert.match(bad.text, /reported failure: boom/);
  assert.match(formatRequestResponse("kay", "not json").text, /Raw response from kay/);
});

// ── plan limits ────────────────────────────────────────────────────

test("plan reserve blocks at threshold and on rejection, releases after reset", () => {
  resetPlanLimits();
  const now = 1_800_000_000_000;
  assert.equal(normalizeUtilization(85), 0.85);
  assert.equal(normalizeUtilization(0.4), 0.4);
  assert.equal(normalizeEpochMs(1_800_000_000), 1_800_000_000_000);

  recordRateLimit({ status: "allowed", rateLimitType: "seven_day", utilization: 0.5, resetsAt: (now + 3600_000) / 1000 }, now);
  assert.equal(checkReserve(0.8, now).blocked, false);

  recordRateLimit({ status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.82, resetsAt: (now + 3600_000) / 1000 }, now);
  const r = checkReserve(0.8, now);
  assert.equal(r.blocked, true);
  assert.match(r.reason!, /seven_day window 82% used/);
  assert.equal(checkReserve(1, now).blocked, false); // reserve disabled

  recordRateLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt: (now + 60_000) / 1000 }, now);
  assert.match(checkReserve(1, now).reason!, /five_hour limit reached/);
  // after both windows reset, work resumes
  assert.equal(checkReserve(0.8, now + 3600_001).blocked, false);
  resetPlanLimits();
});

// ── result classification ──────────────────────────────────────────

const cfg = loadConfig({ ...baseEnv, KNIGHT_MODEL: "sonnet" });
const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 10 };

function resultMsg(over: Record<string, unknown>): any {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 3,
    result: "The brief.",
    total_cost_usd: 0.042,
    usage,
    modelUsage: { "claude-sonnet-4-6": { outputTokens: 50 }, "claude-haiku-4-5": { outputTokens: 5 } },
    duration_ms: 1,
    duration_api_ms: 1,
    stop_reason: "end_turn",
    permission_denials: [],
    session_id: "s",
    uuid: "u",
    ...over,
  };
}

test("success carries text, tokens, cost basis and the primary model", () => {
  const r = classifyResult({ result: resultMsg({}), lastAssistantText: "", aborted: false, config: cfg, durationMs: 10 });
  assert.equal(r.success, true);
  assert.equal(r.result, "The brief.");
  assert.equal(r.billing, "subscription");
  assert.equal(r.cost, 0.042);
  assert.deepEqual(r.tokens, { input: 100, output: 50, cacheRead: 900, cacheWrite: 10 });
  assert.equal(r.model, "claude-sonnet-4-6");
  assert.equal(r.turns, 3);
});

test("empty success falls back to last assistant text, else is an honest failure", () => {
  const withText = classifyResult({ result: resultMsg({ result: "" }), lastAssistantText: "from stream", aborted: false, config: cfg, durationMs: 1 });
  assert.deepEqual([withText.success, withText.result], [true, "from stream"]);
  const none = classifyResult({ result: resultMsg({ result: "  " }), lastAssistantText: "", aborted: false, config: cfg, durationMs: 1 });
  assert.equal(none.success, false);
  assert.match(none.error!, /no deliverable/);
});

test("usage limits, auth failures, timeouts and turn caps are reported as such", () => {
  assert.ok(isUsageLimitMessage("You've hit your limit · resets 5pm"));
  const limited = classifyResult({
    result: resultMsg({ is_error: true, result: "You've hit your limit · resets 5pm" }),
    lastAssistantText: "",
    aborted: false,
    config: cfg,
    durationMs: 1,
  });
  assert.equal(limited.success, false);
  assert.equal(limited.usageLimited, true);

  const auth = classifyResult({ result: undefined, lastAssistantText: "", assistantError: "authentication_failed", aborted: false, config: cfg, durationMs: 1 });
  assert.match(auth.error!, /CLAUDE_CODE_OAUTH_TOKEN/);

  const timeout = classifyResult({ result: undefined, lastAssistantText: "half a report", thrown: "aborted", aborted: true, config: cfg, durationMs: 90_000 });
  assert.match(timeout.error!, /timed out after 90s\. Partial output:\n\nhalf a report/);

  const turns = classifyResult({ result: resultMsg({ subtype: "error_max_turns", is_error: true, errors: [] }), lastAssistantText: "", aborted: false, config: cfg, durationMs: 1 });
  assert.match(turns.error!, /turn limit \(3 turns\)/);
});

// ── introspection mapping ──────────────────────────────────────────

test("transcript messages map to dashboard items", () => {
  const assistant = itemsForMessage({
    type: "assistant",
    uuid: "a1",
    session_id: "s",
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Checking KEV." },
        { type: "tool_use", id: "tu1", name: "WebFetch", input: { url: "https://cisa.gov" } },
      ],
      usage: { input_tokens: 5, output_tokens: 7 },
    },
  } as any);
  assert.equal(assistant.length, 2);
  assert.equal(assistant[0]!.text, "Checking KEV.");
  assert.deepEqual(assistant[0]!.tokens, { input: 5, output: 7 });
  assert.equal(assistant[1]!.type, "tool_use");
  assert.equal(assistant[1]!.toolName, "WebFetch");

  const toolResult = itemsForMessage({
    type: "user",
    uuid: "u1",
    session_id: "s",
    parent_tool_use_id: null,
    parent_agent_id: null,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "403" }], is_error: true }] },
  } as any);
  assert.equal(toolResult[0]!.type, "tool_result");
  assert.equal(toolResult[0]!.text, "⚠ 403");
});

test("refusing knight re-checks usage at an interval and recovers when it drops", async () => {
  resetPlanLimits();
  const { checkReserveRefreshing } = await import("../src/plan-limits.js");
  let t = 1_800_000_000_000;
  const now = () => t;
  const resetsAt = (t + 3 * 3600_000) / 1000;
  recordRateLimit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9, resetsAt }, t);
  let calls = 0;
  let usage = 0.9; // fake rate-limit source
  const probe = async () => {
    calls++;
    recordRateLimit({ status: "allowed", rateLimitType: "five_hour", utilization: usage, resetsAt }, t);
  };
  let cleared = 0;
  const opts = { now, intervalMs: 300_000, onCleared: () => cleared++ };

  // still high: refused, one probe, and no extra calls within the interval
  assert.equal((await checkReserveRefreshing(0.8, probe, opts)).blocked, true);
  assert.equal((await checkReserveRefreshing(0.8, probe, opts)).blocked, true);
  t += 60_000;
  assert.equal((await checkReserveRefreshing(0.8, probe, opts)).blocked, true);
  assert.equal(calls, 1);

  // usage drops; after the interval the next task is accepted
  usage = 0.1;
  t += 300_000;
  assert.equal((await checkReserveRefreshing(0.8, probe, opts)).blocked, false);
  assert.equal(calls, 2);
  assert.equal(cleared, 1);
  resetPlanLimits();
});

test("a failed usage probe keeps the old reading", async () => {
  resetPlanLimits();
  const { checkReserveRefreshing } = await import("../src/plan-limits.js");
  const t = 1_800_000_000_000;
  recordRateLimit({ status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9, resetsAt: (t + 3600_000) / 1000 }, t);
  const r = await checkReserveRefreshing(0.8, async () => { throw new Error("boom"); }, { now: () => t });
  assert.equal(r.blocked, true);
  resetPlanLimits();
});

test("buildChildEnv passes the active task span to the child as TRACEPARENT", async () => {
  const { startTelemetry, withTaskSpan } = await import("@roundtable/knight-core");
  const { InMemorySpanExporter, SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
  // The NodeSDK reads process.env, so clear ambient OTEL_* (knight pods set OTEL_SDK_DISABLED) for this test only.
  const ambientOtel = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("OTEL_")));
  const clearOtelEnv = () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("OTEL_")) delete process.env[k];
  };
  clearOtelEnv();
  try {
    assert.equal(buildChildEnv("api", {}, {})["TRACEPARENT"], undefined);
    const t = await startTelemetry({
      service: "claude-knight",
      knight: "k",
      env: { OTEL_TRACES_EXPORTER: "otlp" },
      spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
    });
    try {
      const child = await withTaskSpan({ taskId: "t", knight: "k" }, async () => buildChildEnv("api", {}, {}));
      assert.match(child["TRACEPARENT"] ?? "", /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    } finally {
      await t.shutdown();
    }
  } finally {
    clearOtelEnv();
    Object.assign(process.env, ambientOtel);
  }
});
