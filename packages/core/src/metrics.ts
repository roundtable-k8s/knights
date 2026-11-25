import client from "prom-client";

export interface KnightMetricsOptions {
  /** The runtime label value, e.g. "pi" or "claude". */
  runtime: string;
  /** The knight name; becomes a constant `knight` label on every series. */
  knight: string;
  /** The table name (ROUNDTABLE_TABLE); empty or unset is reported as "none". */
  table?: string;
  /** Task duration histogram buckets (seconds). */
  taskDurationBuckets?: number[];
  /** Override the LLM cost counter's help text. */
  llmCostHelp?: string;
}

/** Metric name prefix shared by every runtime. */
export const METRIC_PREFIX = "roundtable_knight";

/** The `type` label values of the tokens counter. */
export type TokenType = "input" | "output" | "cache_read" | "cache_write";

export type KnightMetrics = ReturnType<typeof createKnightMetrics>;

/**
 * The shared registry plus the metrics every runtime has. Runtime-only metrics
 * (pi: tool call duration; claude: usage limit hits) are registered by the runtime on
 * `registry`.
 */
export function createKnightMetrics(opts: KnightMetricsOptions) {
  const prefix = METRIC_PREFIX;
  const registry = new client.Registry();
  // Every series (including the default process metrics) carries table, knight and runtime.
  registry.setDefaultLabels({ table: opts.table || "none", knight: opts.knight, runtime: opts.runtime });
  client.collectDefaultMetrics({ register: registry });

  const tasksTotal = new client.Counter({
    name: `${prefix}_tasks_total`,
    help: "Total tasks processed",
    labelNames: ["status"] as const,
    registers: [registry],
  });
  const taskDuration = new client.Histogram({
    name: `${prefix}_task_duration_seconds`,
    help: "Task execution duration in seconds",
    buckets: opts.taskDurationBuckets ?? [1, 5, 10, 30, 60, 120, 300, 600, 1800],
    registers: [registry],
  });
  const llmCost = new client.Counter({
    name: `${prefix}_llm_cost_usd_total`,
    help: opts.llmCostHelp ?? "Total LLM cost in USD",
    labelNames: ["model", "billing"] as const,
    registers: [registry],
  });
  const tokensTotal = new client.Counter({
    name: `${prefix}_llm_tokens_total`,
    help: "Total LLM tokens used",
    labelNames: ["model", "type"] as const,
    registers: [registry],
  });
  const natsConnected = new client.Gauge({
    name: `${prefix}_nats_connected`,
    help: "NATS connection status (1=connected, 0=disconnected)",
    registers: [registry],
  });
  const activeTasks = new client.Gauge({
    name: `${prefix}_active_tasks`,
    help: "Currently active tasks",
    registers: [registry],
  });
  const toolCallDuration = new client.Histogram({
    name: `${prefix}_tool_call_duration_seconds`,
    help: "Tool call execution duration in seconds",
    labelNames: ["tool"] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
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
  function recordLostTask(): void {
    tasksTotal.labels("lost").inc();
  }

  /** Count one task's token usage; token types the runtime did not report are skipped. */
  function recordTokens(model: string, t: { input: number; output: number; cacheRead?: number; cacheWrite?: number }): void {
    const types: [TokenType, number | undefined][] = [
      ["input", t.input],
      ["output", t.output],
      ["cache_read", t.cacheRead],
      ["cache_write", t.cacheWrite],
    ];
    for (const [type, n] of types) if (n !== undefined) tokensTotal.labels(model, type).inc(n);
  }

  return { registry, tasksTotal, taskDuration, llmCost, tokensTotal, natsConnected, activeTasks, toolCallDuration, toolCallsTotal, toolCallsBlocked, recordLostTask, recordTokens };
}
