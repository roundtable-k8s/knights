import { test } from "node:test";
import assert from "node:assert/strict";
import { createKnightMetrics } from "../src/metrics.ts";

const metricNames = (text: string) =>
  [...text.matchAll(/^# TYPE (\S+)/gm)].map((m) => m[1]!).filter((n) => /^roundtable_knight_/.test(n)).sort();

const opts = { runtime: "pi", knight: "galahad" };

test("recordLostTask increments tasks_total with status=lost, not error", async () => {
  const m = createKnightMetrics(opts);
  m.recordLostTask();
  const text = await m.registry.metrics();
  assert.match(text, /roundtable_knight_tasks_total\{status="lost",table="none",knight="galahad",runtime="pi"\} 1/);
  assert.doesNotMatch(text, /status="error"/);
});

test("a task increments tasks_total with table=none by default and the table when set", async () => {
  const none = createKnightMetrics({ ...opts, table: "" });
  none.tasksTotal.labels("success").inc();
  const t1 = await none.registry.metrics();
  assert.match(t1, /roundtable_knight_tasks_total\{status="success",table="none",knight="galahad",runtime="pi"\} 1/);

  const named = createKnightMetrics({ ...opts, table: "x" });
  named.tasksTotal.labels("success").inc();
  const t2 = await named.registry.metrics();
  assert.match(t2, /roundtable_knight_tasks_total\{status="success",table="x",knight="galahad",runtime="pi"\} 1/);
});

test("metric names and labels are the shared roundtable_knight_* scheme", async () => {
  const m = createKnightMetrics(opts);
  m.tasksTotal.labels("ok").inc();
  m.taskDuration.observe(1);
  m.llmCost.labels("m", "api").inc(1);
  m.recordTokens("m", { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  m.natsConnected.set(1);
  m.activeTasks.set(0);
  m.toolCallsTotal.labels("t", "ok").inc();
  m.toolCallDuration.labels("t").observe(1);
  m.toolCallsBlocked.labels("t", "r").inc();
  m.usageLimitHits.labels().inc();
  const text = await m.registry.metrics();
  assert.deepEqual(metricNames(text), [
    "roundtable_knight_active_tasks",
    "roundtable_knight_llm_cost_usd_total",
    "roundtable_knight_llm_tokens_total",
    "roundtable_knight_nats_connected",
    "roundtable_knight_nats_reconnects_total",
    "roundtable_knight_task_duration_seconds",
    "roundtable_knight_tasks_total",
    "roundtable_knight_tool_call_duration_seconds",
    "roundtable_knight_tool_calls_blocked_total",
    "roundtable_knight_tool_calls_total",
    "roundtable_knight_usage_limit_hits_total",
  ]);
  assert.doesNotMatch(text, /pi_knight_|claude_knight_/);
  assert.match(text, /roundtable_knight_llm_cost_usd_total\{model="m",billing="api",table="none",knight="galahad",runtime="pi"\} 1/);
  for (const [type, n] of [["input", 1], ["output", 2], ["cache_read", 3], ["cache_write", 4]] as const) {
    assert.match(text, new RegExp(`roundtable_knight_llm_tokens_total\\{model="m",type="${type}",table="none",knight="galahad",runtime="pi"\\} ${n}`));
  }
  assert.match(text, /roundtable_knight_usage_limit_hits_total\{table="none",knight="galahad",runtime="pi"\} 1/);
  assert.match(text, /roundtable_knight_tool_calls_blocked_total\{tool="t",reason="r",table="none",knight="galahad",runtime="pi"\} 1/);
});

test("claude runtime: cost help override", async () => {
  const m = createKnightMetrics({ runtime: "claude", knight: "k", taskDurationBuckets: [1, 3600], llmCostHelp: "API-equivalent" });
  m.llmCost.labels("m", "subscription").inc(2);
  m.taskDuration.observe(1);
  const text = await m.registry.metrics();
  assert.match(text, /# HELP roundtable_knight_llm_cost_usd_total API-equivalent/);
  assert.match(text, /roundtable_knight_llm_cost_usd_total\{model="m",billing="subscription",table="none",knight="k",runtime="claude"\} 2/);
  assert.match(text, /roundtable_knight_task_duration_seconds_bucket\{le="3600",table="none",knight="k",runtime="claude"\} 1/);
});

test("setNatsConnected drives the gauge and counts a reconnect only after a disconnect", async () => {
  const m = createKnightMetrics(opts);
  m.setNatsConnected(true);
  assert.match(await m.registry.metrics(), /roundtable_knight_nats_reconnects_total\{[^}]*\} 0/);
  m.setNatsConnected(false);
  assert.match(await m.registry.metrics(), /roundtable_knight_nats_connected\{[^}]*\} 0/);
  m.setNatsConnected(true);
  const text = await m.registry.metrics();
  assert.match(text, /roundtable_knight_nats_connected\{[^}]*\} 1/);
  assert.match(text, /roundtable_knight_nats_reconnects_total\{[^}]*\} 1/);
});
