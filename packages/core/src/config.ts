import { log } from "./logger.js";

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

export function floatEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Strict numeric parse shared by the validated settings: the whole trimmed string must be a number, so
 * "1e3" and "0x10" are accepted while "12abc" is rejected (unlike parseInt). Returns null when invalid.
 */
function strictNumber(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Integer setting that must be at least `min` (default 1). An unparseable or too-small value logs a
 * warning naming the variable and falls back; never returns NaN.
 */
export function positiveIntEnv(env: Env, name: string, fallback: number, opts: { min?: number } = {}): number {
  const min = opts.min ?? 1;
  const raw = env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = strictNumber(raw);
  if (n === null || !Number.isInteger(n) || n < min) {
    log.warn(`Invalid ${name}, using default`, { name, value: raw, min, fallback });
    return fallback;
  }
  return n;
}

/** Like positiveIntEnv, for fractional settings (e.g. a number of days); `min` defaults to 0, so it means "non-negative". */
export function nonNegativeFloatEnv(env: Env, name: string, fallback: number, opts: { min?: number } = {}): number {
  const min = opts.min ?? 0;
  const raw = env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const n = strictNumber(raw);
  if (n === null || n < min) {
    log.warn(`Invalid ${name}, using default`, { name, value: raw, min, fallback });
    return fallback;
  }
  return n;
}

/** Split a comma-separated topic list: trim entries and drop empty ones. */
export function parseTopics(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** MAX_CONCURRENT_TASKS, never below 1 so the pull loop cannot stall on 0, negative or NaN. */
export function maxConcurrentTasks(env: Env, fallback: number): number {
  const raw = env["MAX_CONCURRENT_TASKS"];
  if (raw == null || raw.trim() === "") return fallback;
  const n = strictNumber(raw);
  if (n === null || !Number.isInteger(n) || n < 1) {
    log.warn("Invalid MAX_CONCURRENT_TASKS, using minimum of 1", { name: "MAX_CONCURRENT_TASKS", value: raw });
    return 1;
  }
  return n;
}

export function loadBaseConfig(env: Env = process.env): BaseKnightConfig {
  const taskTimeoutMs = positiveIntEnv(env, "TASK_TIMEOUT_MS", 1_800_000);
  return {
    knightName: requireEnv(env, "KNIGHT_NAME"),
    table: env["ROUNDTABLE_TABLE"]?.trim() || "none",
    natsUrl: env["NATS_URL"] ?? "nats://nats.database.svc.cluster.local:4222",
    natsResultsPrefix: env["NATS_RESULTS_PREFIX"] ?? "fleet-a.results",
    metricsPort: intEnv(env, "METRICS_PORT", 3000),
    logLevel: env["LOG_LEVEL"] ?? "info",
    taskTimeoutMs,
    drainTimeoutMs: positiveIntEnv(env, "DRAIN_TIMEOUT_MS", taskTimeoutMs + 60_000),
    ...(env["KNIGHT_MEMORY_DIR"] ? { memoryDir: env["KNIGHT_MEMORY_DIR"] } : {}),
    ...(env["KNIGHT_MEMORY_ROOT"] ? { memoryRoot: env["KNIGHT_MEMORY_ROOT"] } : {}),
    ...(env["KNIGHT_CARDS_BUCKET"]?.trim() ? { cardsBucket: env["KNIGHT_CARDS_BUCKET"].trim() } : {}),
  };
}
