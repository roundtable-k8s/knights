import assert from "node:assert/strict";
import { test } from "node:test";
import { observeQueueWait, recordLostTask, registry } from "../src/runtime-metrics.js";

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
