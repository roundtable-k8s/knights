import { test } from "node:test";
import assert from "node:assert/strict";
import { lostTaskResult, taskResultErrors } from "@roundtable/knight-core";
import { readFixture, resultFixtureDiff } from "@roundtable/knight-core/contract/fixtures";
import { loadConfig } from "../src/config.js";
import { buildResultPayload, classifyResult, failedOutcome, invalidResultPayload, lostResultPayload, reserveRefusedOutcome, type TaskResult } from "../src/result.js";

// Golden fixtures (packages/core/contract/fixtures, roundtable-k8s/knights#6).
const config = loadConfig({ KNIGHT_NAME: "galahad", SUBSCRIBE_TOPICS: "rt.tasks.security.>", CLAUDE_MODEL: "claude-opus-5-5" });
const meta = { taskId: "t-1", knight: "galahad", durationMs: 5000, timestamp: "2026-11-24T10:00:05.000Z" };
const run: TaskResult = {
  result: "Done.",
  success: true,
  cost: 0.0125,
  billing: "subscription",
  tokens: { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0 },
  model: "claude-opus-5-5",
  toolCalls: 4,
  turns: 3,
};

test("fixture result.success: buildResultPayload matches", () => {
  assert.deepEqual(resultFixtureDiff(buildResultPayload(run, meta), "result.success"), []);
});

test("fixture result.failure: buildResultPayload matches", () => {
  const msg = "Agent produced no deliverable output";
  const p = buildResultPayload({ ...run, success: false, result: msg, error: msg }, meta);
  assert.deepEqual(resultFixtureDiff(p, "result.failure"), []);
});

test("fixture result.structured: buildResultPayload matches", () => {
  const f = readFixture<{ result: string; prs: TaskResult["prs"] }>("result.structured");
  const p = buildResultPayload({ ...run, result: f.result, prs: f.prs, verdict: "ship_it" }, meta);
  assert.deepEqual(resultFixtureDiff(p, "result.structured"), []);
});

test("fixture result.refused-quota: a plan-reserve refusal publishes refused quota + usage_limited", () => {
  const p = buildResultPayload(
    reserveRefusedOutcome("Claude plan five_hour limit reached (resets 2026-11-24T15:00:00.000Z)", config),
    meta,
  );
  assert.equal(p.refused, "quota");
  assert.equal(p.usage_limited, true);
  assert.deepEqual(resultFixtureDiff(p, "result.refused-quota"), []);
});

test("a usage-limit run classifies to refused: quota + usage_limited: true", () => {
  const out = classifyResult({
    result: undefined,
    lastAssistantText: "",
    assistantError: "rate_limit",
    aborted: false,
    config,
    durationMs: 5000,
  });
  assert.equal(out.usageLimited, true);
  const p = buildResultPayload(out, meta);
  assert.equal(p.refused, "quota");
  assert.equal(p.usage_limited, true);
  assert.equal(p.success, false);
});

test("a thrown error is a plain failure with no refused field", () => {
  const p = buildResultPayload(failedOutcome("boom", config), meta);
  assert.equal("refused" in p, false);
  assert.equal(p.result, "Task failed: boom");
  assert.equal(p.success, false);
  assert.equal(p.error, "boom");
  assert.deepEqual(resultFixtureDiff(p, "result.failure").filter((d) => d.startsWith("schema:")), []);
});

test("fixture result.lost: the lost-task result with claude-knight runtime fields matches", () => {
  const p = lostResultPayload(config, { task: "Do it", taskId: "t-1" });
  assert.equal(p.runtime, "claude-knight");
  assert.equal(p.billing, "subscription");
  assert.equal(p.lost, true);
  assert.deepEqual(taskResultErrors(p), []);
  // The fixture is a lost result without an echoed task; the echo itself is asserted below.
  const { task: _echo, ...withoutEcho } = p;
  assert.deepEqual(resultFixtureDiff({ ...withoutEcho, timestamp: meta.timestamp }, "result.lost"), []);
  assert.deepEqual(p.task, { taskId: "t-1", task: "Do it" });
});

test("lost result bytes: the builder output is the core lost result plus runtime fields, unchanged", () => {
  const parsed = { task: "Do it", taskId: "t-1", attempt: 2, retryOf: "t-0" };
  const expected = { ...lostTaskResult({ taskId: "t-1", knight: "galahad", model: "claude-opus-5-5", parsed }), runtime: "claude-knight", billing: "subscription" } as Record<string, unknown>;
  // Both sides stamp their own timestamp; compare everything else.
  const { timestamp: _got, ...got } = lostResultPayload(config, parsed);
  const { timestamp: _want, ...want } = expected;
  assert.deepEqual(got, want);
});

test("lost result falls back to the default model when no Claude model is configured", () => {
  const bare = loadConfig({ KNIGHT_NAME: "galahad", SUBSCRIBE_TOPICS: "rt.tasks.security.>" });
  assert.equal(lostResultPayload(bare, { task: "x", taskId: "t-1" }).model, "claude-code-default");
});

test("invalid result: names the bad field, is a valid failure, carries runtime fields", () => {
  const p = invalidResultPayload(config, { task: "", taskId: "t-1", invalid: "task: Required" });
  assert.deepEqual(taskResultErrors(p), []);
  assert.equal(p.success, false);
  assert.equal(p.error, "Invalid task payload: task: Required");
  assert.ok(p.result.startsWith("Task failed: Invalid task payload:"));
  assert.equal(p.runtime, "claude-knight");
  assert.equal(p.billing, "subscription");
  assert.equal(p.model, "claude-opus-5-5");
  assert.equal("task" in p, false);
  assert.equal("lost" in p, false);
});

test("retry attempt: result carries attempt/retry_of; only a failure carries the task (#36)", () => {
  const parsed = { task: "Do it", taskId: "t-1", attempt: 2, retryOf: "t-0" };
  const ok = buildResultPayload(run, { ...meta, parsed });
  assert.equal(ok.attempt, 2);
  assert.equal(ok.retry_of, "t-0");
  assert.ok(!("task" in ok));
  const fail = buildResultPayload({ ...run, success: false, error: "x" }, { ...meta, parsed });
  assert.equal(fail.task?.task, "Do it");
  assert.ok(!("attempt" in buildResultPayload(run, meta)));
});

test("fixture result.transient: an overloaded API error publishes transient overloaded", () => {
  const out = classifyResult({
    result: { type: "result", subtype: "success", is_error: true, result: "API Error: 529 Overloaded", num_turns: 1 } as never,
    lastAssistantText: "",
    aborted: false,
    config,
    durationMs: 5000,
    toolCalls: 0,
  });
  assert.equal(out.success, false);
  const p = buildResultPayload({ ...out, cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, model: "claude-opus-5-5" }, { ...meta, durationMs: 5000 });
  assert.equal(p.transient, true);
  assert.equal(p.transientReason, "overloaded");
  assert.deepEqual(resultFixtureDiff({ ...p, result: "Task failed: API Error: 529 Overloaded", error: "API Error: 529 Overloaded", turns: 0 }, "result.transient"), []);
});

test("a NATS connection error or a stray 529 is not transient", () => {
  for (const msg of ["connection error", "NatsError: CONNECTION_CLOSED", "processed 529 records"]) {
    const p = buildResultPayload(failedOutcome(msg, config), meta);
    assert.ok(!("transient" in p) && !("transientReason" in p), msg);
  }
  assert.equal(buildResultPayload(failedOutcome("API Error: 529 Overloaded", config), meta).transientReason, "overloaded");
});

test("a thrown connection reset is transient network; an ordinary failure is not", () => {
  assert.equal(buildResultPayload(failedOutcome("read ECONNRESET", config), meta).transientReason, "network");
  const plain = buildResultPayload(failedOutcome("boom", config), meta);
  assert.ok(!("transient" in plain) && !("transientReason" in plain));
  const turns = classifyResult({
    result: { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 500 } as never,
    lastAssistantText: "tests failed with HTTP 503 in fixture",
    aborted: false,
    config,
    durationMs: 1,
  });
  assert.equal(turns.transient, undefined);
});

test("cache usage: tokens.cacheRead and cacheWrite are published, input stays uncached", () => {
  const out = classifyResult({
    result: { type: "result", subtype: "success", is_error: false, result: "ok", num_turns: 1, total_cost_usd: 0.1,
      usage: { input_tokens: 6, output_tokens: 40, cache_read_input_tokens: 9000, cache_creation_input_tokens: 1500 } } as never,
    lastAssistantText: "",
    aborted: false,
    config,
    durationMs: 1000,
  });
  assert.deepEqual(buildResultPayload(out, meta).tokens, { input: 6, output: 40, cacheRead: 9000, cacheWrite: 1500 });
});

test("tool_calls is published (0 included) and the payload still validates", () => {
  const p = buildResultPayload({ ...run, toolCalls: 2 }, meta);
  assert.equal(p.tool_calls, 2);
  assert.equal(buildResultPayload({ ...run, toolCalls: 0 }, meta).tool_calls, 0);
  assert.equal("tool_calls" in buildResultPayload({ ...run, toolCalls: undefined }, meta), false);
  const failed = classifyResult({ result: undefined, lastAssistantText: "", thrown: "boom", aborted: false, config, durationMs: 1, toolCalls: 3 });
  assert.equal(buildResultPayload(failed, meta).tool_calls, 3);
});
