import client from "prom-client";
import { createKnightMetrics } from "@roundtable/knight-core";

const metrics = createKnightMetrics({
  runtime: "claude",
  knight: process.env["KNIGHT_NAME"] ?? "unknown",
  table: process.env["ROUNDTABLE_TABLE"],
  taskDurationBuckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600],
  llmCostHelp: "LLM cost in USD at API list prices. In subscription mode this is API-equivalent, not billed spend.",
});

export const {
  registry,
  tasksTotal,
  taskDuration,
  llmCost,
  tokensTotal,
  natsConnected,
  natsReconnects,
  setNatsConnected,
  activeTasks,
  toolCallDuration,
  toolCallsTotal,
  toolCallsBlocked,
  recordLostTask,
  recordTokens,
} = metrics;

// ─── claude-knight only ─────────────────────────────────────────────

export const usageLimitHits = new client.Counter({
  name: "roundtable_knight_usage_limit_hits_total",
  help: "Tasks that failed because the Claude plan or credit limit was reached",
  registers: [registry],
});
