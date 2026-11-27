import assert from "node:assert/strict";
import { test } from "node:test";
import { observeQueuedFor, observeQueueWait, recordLostTask, registry } from "../src/runtime-metrics.js";

test("lost tasks are counted with status=lost, not error", async () => {
  recordLostTask();
  const m = await registry.getSingleMetricAsString("roundtable_knight_tasks_total");
  assert.match(m, /roundtable_knight_tasks_total\{status="lost",table="none",knight="[^"]*",runtime="claude"\} 1/);
  assert.doesNotMatch(m, /status="error"/);
});

test("observeQueueWait records the queue wait in the runtime registry", async () => {
  observeQueueWait(30_000);
  const m = await registry.getSingleMetricAsString("roundtable_knight_task_queue_seconds");
  assert.match(m, /roundtable_knight_task_queue_seconds_bucket\{le="60",table="none",knight="[^"]*",runtime="claude"\} 1/);
});

test("observeQueuedFor computes and records the wait for a task with publishedAtMs", async () => {
  assert.equal(observeQueuedFor(undefined, 5_000), undefined);
  assert.equal(observeQueuedFor(10_000, 5_000), 0); // clock skew never goes negative
  const before = await registry.getSingleMetricAsString("roundtable_knight_task_queue_seconds");
  const bucket300 = (m: string) => Number(/task_queue_seconds_bucket\{le="300"[^}]*\} (\d+)/.exec(m)?.[1] ?? NaN);
  const count = (m: string) => Number(/task_queue_seconds_count\{[^}]*\} (\d+)/.exec(m)?.[1] ?? 0);
  assert.equal(observeQueuedFor(1_000, 121_000), 120_000);
  const after = await registry.getSingleMetricAsString("roundtable_knight_task_queue_seconds");
  assert.equal(count(after), count(before) + 1);
  assert.equal(bucket300(after), bucket300(before) + 1); // 120 s falls in le="300"
});
