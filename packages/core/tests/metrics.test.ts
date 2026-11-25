import { test } from "node:test";
import assert from "node:assert/strict";
import { createKnightMetrics } from "../src/metrics.ts";

const metricNames = (text: string) =>
  [...text.matchAll(/^# TYPE (\S+)/gm)].map((m) => m[1]).filter((n) => /_knight_/.test(n)).sort();

test("recordLostTask increments tasks_total with status=lost, not error", async () => {
  const m = createKnightMetrics({ prefix: "pi_knight" });
  m.recordLostTask("galahad");
  const text = await m.registry.metrics();
  assert.match(text, /pi_knight_tasks_total\{knight="galahad",status="lost"\} 1/);
  assert.doesNotMatch(text, /pi_knight_tasks_total\{knight="galahad",status="error"\}/);
});

test("metric names and labels are stable per prefix (pi_knight)", async () => {
  const m = createKnightMetrics({ prefix: "pi_knight" });
  m.tasksTotal.labels("k", "ok").inc();
  m.taskDuration.labels("k").observe(1);
  m.llmCost.labels("k", "m").inc(1);
  m.tokensTotal.labels("k", "in").inc(1);
  m.natsConnected.labels("k").set(1);
  m.activeTasks.labels("k").set(0);
  m.toolCallsTotal.labels("t", "ok").inc();
  m.toolCallsBlocked.labels("t", "r").inc();
  const text = await m.registry.metrics();
  assert.deepEqual(metricNames(text), [
    "pi_knight_active_tasks",
    "pi_knight_llm_cost_dollars_total",
    "pi_knight_nats_connected",
    "pi_knight_task_duration_seconds",
    "pi_knight_tasks_total",
    "pi_knight_tokens_total",
    "pi_knight_tool_calls_blocked_total",
    "pi_knight_tool_calls_total",
  ]);
  assert.match(text, /pi_knight_llm_cost_dollars_total\{knight="k",model="m"\} 1/);
  assert.match(text, /pi_knight_tool_calls_blocked_total\{tool="t",reason="r"\} 1/);
});

test("claude-style overrides: extra llm cost label and bucket", async () => {
  const m = createKnightMetrics({
    prefix: "claude_knight",
    taskDurationBuckets: [1, 3600],
    llmCost: { labelNames: ["knight", "model", "billing"] },
  });
  m.llmCost.labels("k", "m", "sub").inc(2);
  m.taskDuration.labels("k").observe(1);
  const text = await m.registry.metrics();
  assert.match(text, /claude_knight_llm_cost_dollars_total\{knight="k",model="m",billing="sub"\} 2/);
  assert.match(text, /claude_knight_task_duration_seconds_bucket\{le="3600",knight="k"\} 1/);
});
