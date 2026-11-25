import { createKnightMetrics } from "@roundtable/knight-core";

// pi-knight has no auth-mode switch: it bills per token via API keys, unless it runs
// on an Anthropic OAuth token (subscription spend).
export const BILLING: "api" | "subscription" = process.env["ANTHROPIC_OAUTH_TOKEN"] ? "subscription" : "api";

const metrics = createKnightMetrics({ runtime: "pi", knight: process.env["KNIGHT_NAME"] ?? "unknown", table: process.env["ROUNDTABLE_TABLE"] });

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
