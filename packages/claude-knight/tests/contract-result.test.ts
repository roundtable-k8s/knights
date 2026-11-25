import { test } from "node:test";
import assert from "node:assert/strict";
import { lostTaskResult } from "@roundtable/knight-core";
import { readFixture, resultFixtureDiff } from "@roundtable/knight-core/contract/fixtures";
import { loadConfig } from "../src/config.js";
import { buildResultPayload, classifyResult, failedOutcome, reserveRefusedOutcome, runtimeFields, type TaskResult } from "../src/result.js";

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
  const p = { ...lostTaskResult({ taskId: "t-1", knight: "galahad", model: "claude-opus-5-5", timestamp: meta.timestamp }), ...runtimeFields(config) };
  assert.equal(p.runtime, "claude-knight");
  assert.deepEqual(resultFixtureDiff(p, "result.lost"), []);
});
