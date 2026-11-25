import { createKnightMetrics } from "@roundtable/knight-core";

// pi-knight has no auth-mode switch: it always calls model providers with API keys.
export const BILLING = "api";

const metrics = createKnightMetrics({ runtime: "pi", knight: process.env["KNIGHT_NAME"] ?? "unknown", table: process.env["ROUNDTABLE_TABLE"] });

export const {
  registry,
  tasksTotal,
  taskDuration,
  llmCost,
  tokensTotal,
  natsConnected,
  activeTasks,
  toolCallDuration,
  toolCallsTotal,
  toolCallsBlocked,
  recordLostTask,
  recordTokens,
} = metrics;
