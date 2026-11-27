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

/** Time a task sat in the queue before this knight started it (undefined when the publisher sent no timestamp); records it in the queue-wait histogram. */
export function observeQueuedFor(publishedAtMs: number | undefined, startedMs: number): number | undefined {
  const queuedFor = publishedAtMs ? Math.max(0, startedMs - publishedAtMs) : undefined;
  observeQueueWait(queuedFor);
  return queuedFor;
}
