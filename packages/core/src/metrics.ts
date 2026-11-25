import client from "prom-client";

export interface KnightMetricsOptions {
  /** Metric name prefix, e.g. "pi_knight" or "claude_knight". */
  prefix: string;
  /** Task duration histogram buckets (seconds). */
  taskDurationBuckets?: number[];
  /** Override the LLM cost counter's help text and labels (default: knight, model). */
  llmCost?: { help?: string; labelNames?: string[] };
}

export type KnightMetrics = ReturnType<typeof createKnightMetrics>;

/**
 * The shared registry plus the metrics every runtime has. Runtime-only metrics
 * (pi: tool call duration/errors; claude: usage limit hits) are registered by the runtime on
 * `registry`.
 */
export function createKnightMetrics(opts: KnightMetricsOptions) {
  const { prefix } = opts;
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const tasksTotal = new client.Counter({
    name: `${prefix}_tasks_total`,
    help: "Total tasks processed",
    labelNames: ["knight", "status"] as const,
    registers: [registry],
  });
  const taskDuration = new client.Histogram({
    name: `${prefix}_task_duration_seconds`,
    help: "Task execution duration in seconds",
    labelNames: ["knight"] as const,
    buckets: opts.taskDurationBuckets ?? [1, 5, 10, 30, 60, 120, 300, 600, 1800],
    registers: [registry],
  });
  const llmCost = new client.Counter<string>({
    name: `${prefix}_llm_cost_dollars_total`,
    help: opts.llmCost?.help ?? "Total LLM cost in dollars",
    labelNames: opts.llmCost?.labelNames ?? ["knight", "model"],
    registers: [registry],
  });
  const tokensTotal = new client.Counter({
    name: `${prefix}_tokens_total`,
    help: "Total tokens used",
    labelNames: ["knight", "direction"] as const,
    registers: [registry],
  });
  const natsConnected = new client.Gauge({
    name: `${prefix}_nats_connected`,
    help: "NATS connection status (1=connected, 0=disconnected)",
    labelNames: ["knight"] as const,
    registers: [registry],
  });
  const activeTasks = new client.Gauge({
    name: `${prefix}_active_tasks`,
    help: "Currently active tasks",
    labelNames: ["knight"] as const,
    registers: [registry],
  });
  const toolCallsTotal = new client.Counter({
    name: `${prefix}_tool_calls_total`,
    help: "Total tool calls executed",
    labelNames: ["tool", "status"] as const,
    registers: [registry],
  });
  const toolCallsBlocked = new client.Counter({
    name: `${prefix}_tool_calls_blocked_total`,
    help: "Total tool calls blocked by safety hooks",
    labelNames: ["tool", "reason"] as const,
    registers: [registry],
  });

  /** A task delivered to a knight that stopped before finishing it (max_deliver=1, never re-run). */
  function recordLostTask(knight: string): void {
    tasksTotal.labels(knight, "lost").inc();
  }

  return { registry, tasksTotal, taskDuration, llmCost, tokensTotal, natsConnected, activeTasks, toolCallsTotal, toolCallsBlocked, recordLostTask };
}
