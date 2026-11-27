import test from "node:test";
import assert from "node:assert/strict";
import { recordSubagentUsage } from "../src/tools/subagent.js";
import { observeQueueWait, registry } from "../src/runtime-metrics.js";

test("sub-agent usage records cache_write alongside the other token types", async () => {
  recordSubagentUsage("p/m", { cost: 0.01, tokens: { input: 10, output: 5, cacheRead: 7, cacheWrite: 3 } }, false);
  const text = await registry.metrics();
  const line = (type: string) =>
    text.split("\n").find((l) => l.startsWith("roundtable_knight_llm_tokens_total") && l.includes('model="p/m"') && l.includes(`type="${type}"`));
  assert.match(line("cache_write") ?? "", / 3$/);
  assert.match(line("cache_read") ?? "", / 7$/);
  assert.match(line("input") ?? "", / 10$/);
});

test("observeQueueWait is exported by the pi runtime registry", async () => {
  observeQueueWait(30_000);
  const text = await registry.getSingleMetricAsString("roundtable_knight_task_queue_seconds");
  assert.match(text, /roundtable_knight_task_queue_seconds_bucket\{le="60",table="none",knight="[^"]*",runtime="pi"\} 1/);
});
