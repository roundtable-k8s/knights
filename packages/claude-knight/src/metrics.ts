import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

// Metric names mirror pi-knight's (pi_knight_* → claude_knight_*) so dashboards
// can union the two with a regex on __name__.

export const tasksTotal = new client.Counter({
  name: "claude_knight_tasks_total",
  help: "Total tasks processed",
  labelNames: ["knight", "status"] as const,
  registers: [registry],
});

export const taskDuration = new client.Histogram({
  name: "claude_knight_task_duration_seconds",
  help: "Task execution duration in seconds",
  labelNames: ["knight"] as const,
  buckets: [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [registry],
});

export const llmCost = new client.Counter({
  name: "claude_knight_llm_cost_dollars_total",
  help: "LLM cost in USD at API list prices. In subscription mode this is API-equivalent, not billed spend.",
  labelNames: ["knight", "model", "billing"] as const,
  registers: [registry],
});

export const tokensTotal = new client.Counter({
  name: "claude_knight_tokens_total",
  help: "Total tokens used",
  labelNames: ["knight", "direction"] as const,
  registers: [registry],
});

export const natsConnected = new client.Gauge({
  name: "claude_knight_nats_connected",
  help: "NATS connection status (1=connected, 0=disconnected)",
  labelNames: ["knight"] as const,
  registers: [registry],
});

export const activeTasks = new client.Gauge({
  name: "claude_knight_active_tasks",
  help: "Currently active tasks",
  labelNames: ["knight"] as const,
  registers: [registry],
});

export const toolCallsTotal = new client.Counter({
  name: "claude_knight_tool_calls_total",
  help: "Tool calls executed",
  labelNames: ["tool", "status"] as const,
  registers: [registry],
});

export const toolCallsBlocked = new client.Counter({
  name: "claude_knight_tool_calls_blocked_total",
  help: "Tool calls blocked by safety hooks",
  labelNames: ["tool", "reason"] as const,
  registers: [registry],
});

export const usageLimitHits = new client.Counter({
  name: "claude_knight_usage_limit_hits_total",
  help: "Tasks that failed because the Claude plan or credit limit was reached",
  labelNames: ["knight"] as const,
  registers: [registry],
});

/** Count a task that was delivered to a knight that stopped before finishing it (not re-run). */
export function recordLostTask(knight: string): void {
  tasksTotal.labels(knight, "lost").inc();
}
