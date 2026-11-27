import client from "prom-client";
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
  setInfo,
  activeTasks,
  toolCallDuration,
  toolCallsTotal,
  toolCallsBlocked,
  usageLimitHits,
  observeQueueWait,
  recordLostTask,
  recordTokens,
} = metrics;

// ─── Session health (pi-knight only) ────────────────────────────────

export const compactionsTotal = new client.Counter({
  name: "roundtable_knight_compactions_total",
  help: "Context compactions of the pi session, by trigger reason and outcome (completed|aborted|failed)",
  labelNames: ["reason", "outcome"] as const,
  registers: [registry],
});

export const llmRetriesTotal = new client.Counter({
  name: "roundtable_knight_llm_retries_total",
  help: "LLM auto-retry sequences that ended, by outcome (succeeded|exhausted)",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

export const skillActivationsTotal = new client.Counter({
  name: "roundtable_knight_skill_activations_total",
  help: "Skill activations (the agent read a skill's SKILL.md), by skill name",
  labelNames: ["skill"] as const,
  registers: [registry],
});

export const sessionMessages = new client.Gauge({
  name: "roundtable_knight_session_messages",
  help: "Message count of the session the last task ran in",
  registers: [registry],
});

/** Count a credit refusal (`refused` set on the published result); the task status label stays `error`. */
export function recordRefusal(refused: string | undefined): void {
  if (refused) usageLimitHits.labels().inc();
}
