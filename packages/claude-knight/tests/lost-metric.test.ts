import assert from "node:assert/strict";
import { test } from "node:test";
import { recordLostTask, registry } from "../src/metrics.js";

test("lost tasks are counted with status=lost, not error", async () => {
  recordLostTask("T");
  const m = await registry.getSingleMetricAsString("claude_knight_tasks_total");
  assert.match(m, /claude_knight_tasks_total\{[^}]*knight="T"[^}]*status="lost"[^}]*\} 1/);
  assert.doesNotMatch(m, /knight="T"[^}]*status="error"/);
});
