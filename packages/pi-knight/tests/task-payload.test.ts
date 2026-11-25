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
