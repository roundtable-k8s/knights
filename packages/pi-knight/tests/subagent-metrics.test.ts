import test from "node:test";
import assert from "node:assert/strict";
import { recordSubagentUsage } from "../src/tools/subagent.js";
import { registry } from "../src/runtime-metrics.js";

test("sub-agent usage records cache_write alongside the other token types", async () => {
  recordSubagentUsage("p/m", { cost: 0.01, tokens: { input: 10, output: 5, cacheRead: 7, cacheWrite: 3 } }, false);
  const text = await registry.metrics();
  const line = (type: string) =>
    text.split("\n").find((l) => l.startsWith("roundtable_knight_llm_tokens_total") && l.includes('model="p/m"') && l.includes(`type="${type}"`));
  assert.match(line("cache_write") ?? "", / 3$/);
  assert.match(line("cache_read") ?? "", / 7$/);
  assert.match(line("input") ?? "", / 10$/);
});
