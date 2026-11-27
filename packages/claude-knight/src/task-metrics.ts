import * as metrics from "./runtime-metrics.js";
import type { TaskResult } from "./result.js";

/** Metrics for a task that ran (success or failure). */
export function recordTaskOutcome(outcome: TaskResult, durationMs: number): void {
  metrics.tasksTotal.labels(outcome.success ? "success" : "error").inc();
  metrics.taskDuration.labels().observe(durationMs / 1000);
  metrics.llmCost.labels(outcome.model, outcome.billing).inc(outcome.cost);
  metrics.recordTokens(outcome.model, outcome.tokens);
  if (outcome.usageLimited) metrics.usageLimitHits.labels().inc();
}

/** Metrics for a task refused by the plan reserve before Claude Code ran. */
export function recordReserveRefusal(): void {
  metrics.usageLimitHits.labels().inc();
  metrics.tasksTotal.labels("refused").inc();
}

/** The result could not be published (and was not replaced by a made-up failure). */
export function recordPublishFailed(): void {
  metrics.tasksTotal.labels("publish_failed").inc();
}
