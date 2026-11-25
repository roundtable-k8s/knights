import client from "prom-client";
import { createKnightMetrics } from "@roundtable/knight-core";

// Metric names mirror pi-knight's (pi_knight_* → claude_knight_*) so dashboards
// can union the two with a regex on __name__.
const metrics = createKnightMetrics({
  prefix: "claude_knight",
  taskDurationBuckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600],
  llmCost: {
    help: "LLM cost in USD at API list prices. In subscription mode this is API-equivalent, not billed spend.",
    labelNames: ["knight", "model", "billing"],
  },
});

export const { registry, tasksTotal, taskDuration, llmCost, tokensTotal, natsConnected, activeTasks, toolCallsTotal, toolCallsBlocked, recordLostTask } =
  metrics;

// ─── claude-knight only ─────────────────────────────────────────────

export const usageLimitHits = new client.Counter({
  name: "claude_knight_usage_limit_hits_total",
  help: "Tasks that failed because the Claude plan or credit limit was reached",
  labelNames: ["knight"] as const,
  registers: [registry],
});
