import client from "prom-client";
import { createKnightMetrics } from "@roundtable/knight-core";

const metrics = createKnightMetrics({ prefix: "pi_knight" });

export const { registry, tasksTotal, taskDuration, llmCost, tokensTotal, natsConnected, activeTasks, toolCallsTotal, toolCallsBlocked, recordLostTask } =
  metrics;

// ─── pi-knight only: tool call metrics (used by hooks.ts) ───────────

export const toolCallDuration = new client.Histogram({
  name: "pi_knight_tool_call_duration_seconds",
  help: "Tool call execution duration in seconds",
  labelNames: ["tool"] as const,
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

export const toolCallErrors = new client.Counter({
  name: "pi_knight_tool_call_errors_total",
  help: "Total tool call errors",
  labelNames: ["tool"] as const,
  registers: [registry],
});
