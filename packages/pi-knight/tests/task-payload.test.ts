import { test } from "node:test";
import assert from "node:assert/strict";
import { buildResultPayload, failedTaskResult } from "../src/task-payload.js";
import type { TaskResult } from "../src/knight.js";

const base: TaskResult = {
  result: "r",
  success: false,
  cost: 0,
  tokens: { input: 1, output: 2, cacheRead: 3 },
  model: "p/m",
  toolCalls: 0,
};
const meta = { taskId: "t1", knight: "k", durationMs: 5, timestamp: "2026-01-01T00:00:00Z" };

test("buildResultPayload passes refused through to the published payload (#79)", () => {
  const p = buildResultPayload({ ...base, error: "402", refused: "credits" }, meta);
  assert.equal(p.refused, "credits");
  assert.equal(p.task_id, "t1");
  assert.equal(p.duration_ms, 5);
});

test("buildResultPayload omits optional fields when unset", () => {
  const p = buildResultPayload({ ...base, success: true }, meta);
  for (const k of ["refused", "error", "prs", "verdict"]) assert.ok(!(k in p), k);
});

test("thrown 402 out-of-credits error publishes refused: credits with the usual failure fields", () => {
  const msg = "402 This request requires more credits, or fewer max_tokens";
  const p = buildResultPayload(failedTaskResult(msg, "p/m"), meta);
  assert.equal(p.refused, "credits");
  assert.equal(p.success, false);
  assert.equal(p.error, msg);
  assert.equal(p.result, `Task failed: ${msg}`);
  assert.equal(p.duration_ms, 5);
  assert.equal(p.model, "p/m");
});

test("thrown non-credit error has no refused field", () => {
  const p = buildResultPayload(failedTaskResult("boom", "p/m"), meta);
  assert.equal("refused" in p, false);
  assert.equal(p.success, false);
});

test("buildResultPayload matches the recorded pi-knight result fixture byte for byte", async () => {
  const { readFileSync } = await import("node:fs");
  const { encodeResult } = await import("@roundtable/knight-core");
  const raw = readFileSync(new URL("../../core/tests/fixtures/pi-knight-result.json", import.meta.url), "utf8").trim();
  const msg = "402 This request requires more credits, or fewer max_tokens";
  const p = buildResultPayload(
    { ...failedTaskResult(msg, "openrouter/anthropic/claude-sonnet-4.5"), tokens: { input: 0, output: 0, cacheRead: 0 } },
    { taskId: "lancelot-1764000000000-a1b2c3", knight: "lancelot", durationMs: 1234, timestamp: "2026-11-24T10:00:01.234Z" },
  );
  assert.equal(encodeResult(p), raw);
});

// ── Golden fixtures (packages/core/contract/fixtures, roundtable-k8s/knights#6) ──

import { readFixture, resultFixtureDiff } from "@roundtable/knight-core/contract/fixtures";
import { lostTaskResult } from "@roundtable/knight-core";

const fx = { taskId: "t-1", knight: "galahad", durationMs: 5000, timestamp: "2026-11-24T10:00:05.000Z" };
const run: TaskResult = {
  result: "Done.",
  success: true,
  cost: 0.0125,
  tokens: { input: 1200, output: 340, cacheRead: 800 },
  model: "claude-opus-5-5",
  toolCalls: 4,
};

test("fixture result.success: buildResultPayload matches", () => {
  assert.deepEqual(resultFixtureDiff(buildResultPayload(run, fx), "result.success"), []);
});

test("fixture result.failure: buildResultPayload matches", () => {
  const msg = "Agent produced no deliverable output";
  assert.deepEqual(resultFixtureDiff(buildResultPayload({ ...run, success: false, result: msg, error: msg }, fx), "result.failure"), []);
});

test("fixture result.structured: buildResultPayload matches", () => {
  const f = readFixture<{ result: string; prs: TaskResult["prs"] }>("result.structured");
  const p = buildResultPayload({ ...run, result: f.result, prs: f.prs, verdict: "ship_it" }, fx);
  assert.deepEqual(resultFixtureDiff(p, "result.structured"), []);
});

test("fixture result.refused-credits: a thrown 402 publishes refused credits", () => {
  const p = buildResultPayload(failedTaskResult("402 This request requires more credits, or fewer max_tokens",
    "openrouter/anthropic/claude-sonnet-4.5"), fx);
  assert.deepEqual(resultFixtureDiff(p, "result.refused-credits"), []);
});

test("fixture result.lost: the lost-task result matches", () => {
  assert.deepEqual(resultFixtureDiff(lostTaskResult({ taskId: "t-1", knight: "galahad", model: "claude-opus-5-5", timestamp: fx.timestamp }), "result.lost"), []);
});

test("retry attempt: result carries attempt/retry_of; failure carries the task, success does not (#36)", () => {
  const parsed = { task: "Do it", taskId: "t1", attempt: 2, retryOf: "t0" };
  const fail = buildResultPayload(base, { ...meta, parsed });
  assert.equal(fail.attempt, 2);
  assert.equal(fail.retry_of, "t0");
  assert.equal(fail.task?.task, "Do it");
  const ok = buildResultPayload({ ...base, success: true }, { ...meta, parsed });
  assert.equal(ok.attempt, 2);
  assert.ok(!("task" in ok));
  const first = buildResultPayload({ ...base, success: true }, { ...meta, parsed: { task: "x", taskId: "t1" } });
  assert.ok(!("attempt" in first) && !("retry_of" in first));
});

test("fixture result.transient: a thrown 529 publishes transient overloaded", () => {
  const p = buildResultPayload(failedTaskResult("API Error: 529 Overloaded", "claude-opus-5-5"), fx);
  assert.deepEqual(resultFixtureDiff(p, "result.transient"), []);
});

test("transient reasons: 503 is provider_5xx, ECONNRESET is network", () => {
  assert.equal(buildResultPayload(failedTaskResult("503 Service Unavailable", "m"), meta).transientReason, "provider_5xx");
  assert.equal(buildResultPayload(failedTaskResult("read ECONNRESET", "m"), meta).transientReason, "network");
});

test("ordinary failures and refusals are not transient", () => {
  for (const msg of ["boom", "Task aborted before producing output (task timeout)", "tests failed: 3 of 500 passed", "402 This request requires more credits, or fewer max_tokens"]) {
    const p = buildResultPayload(failedTaskResult(msg, "m"), meta);
    assert.ok(!("transient" in p) && !("transientReason" in p), msg);
  }
});
