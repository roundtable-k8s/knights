export type Env = NodeJS.ProcessEnv;

/** The config both runtimes share: the env contract the operator sets on every knight pod. */
export interface BaseKnightConfig {
  knightName: string;
  /** The table this knight belongs to (ROUNDTABLE_TABLE); "none" when unset or empty. */
  table: string;
  natsUrl: string;
  natsResultsPrefix: string;
  /** Port for the health and metrics HTTP server (METRICS_PORT). */
  metricsPort: number;
  logLevel: string;
  taskTimeoutMs: number;
  /** Max wait for in-flight tasks after SIGTERM. Default taskTimeoutMs + 60s, matching the operator's terminationGracePeriodSeconds. */
  drainTimeoutMs: number;
  /** Per-knight memory volume (KNIGHT_MEMORY_DIR). Unset: memory stays in /data. */
  memoryDir?: string;
  /** Read-only root of every knight's memory (KNIGHT_MEMORY_ROOT). */
  memoryRoot?: string;
  /** NATS KV bucket with the table's agent cards (KNIGHT_CARDS_BUCKET); unset on older operators. */
  cardsBucket?: string;
}

export function requireEnv(env: Env, name: string): string {
  const val = env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

export function intEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadBaseConfig(env: Env = process.env): BaseKnightConfig {
  const taskTimeoutMs = intEnv(env, "TASK_TIMEOUT_MS", 1_800_000);
  return {
    knightName: requireEnv(env, "KNIGHT_NAME"),
    table: env["ROUNDTABLE_TABLE"]?.trim() || "none",
    natsUrl: env["NATS_URL"] ?? "nats://nats.database.svc.cluster.local:4222",
    natsResultsPrefix: env["NATS_RESULTS_PREFIX"] ?? "fleet-a.results",
    metricsPort: intEnv(env, "METRICS_PORT", 3000),
    logLevel: env["LOG_LEVEL"] ?? "info",
    taskTimeoutMs,
    drainTimeoutMs: intEnv(env, "DRAIN_TIMEOUT_MS", taskTimeoutMs + 60_000),
    ...(env["KNIGHT_MEMORY_DIR"] ? { memoryDir: env["KNIGHT_MEMORY_DIR"] } : {}),
    ...(env["KNIGHT_MEMORY_ROOT"] ? { memoryRoot: env["KNIGHT_MEMORY_ROOT"] } : {}),
    ...(env["KNIGHT_CARDS_BUCKET"]?.trim() ? { cardsBucket: env["KNIGHT_CARDS_BUCKET"].trim() } : {}),
  };
}
