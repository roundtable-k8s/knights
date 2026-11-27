import os from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { loadBaseConfig, log, maxConcurrentTasks, parseTopics, nonNegativeFloatEnv, positiveIntEnv, requireEnv, type BaseKnightConfig, type Env } from "@roundtable/knight-core";

/** Thinking levels the SDK accepts (ThinkingLevel in pi-agent-core). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

/** KNIGHT_THINKING: an unset or empty value is "off"; an unknown value warns and is "off". */
function thinkingLevelEnv(env: Env): ThinkingLevel {
  const raw = env["KNIGHT_THINKING"];
  if (!raw) return "off";
  if ((THINKING_LEVELS as readonly string[]).includes(raw)) return raw as ThinkingLevel;
  log.warn(`Invalid KNIGHT_THINKING, using off. Accepted: ${THINKING_LEVELS.join(", ")}`, { name: "KNIGHT_THINKING", value: raw, accepted: THINKING_LEVELS, fallback: "off" });
  return "off";
}

/** ACTIVITY_CONTENT: `none` or `preview` (default); any other non-empty value warns and is `preview`. */
function activityContentEnv(env: Env): "none" | "preview" {
  const raw = env["ACTIVITY_CONTENT"];
  if (!raw || raw === "preview") return "preview";
  if (raw === "none") return "none";
  log.warn("Invalid ACTIVITY_CONTENT, using preview. Accepted: none, preview", { name: "ACTIVITY_CONTENT", value: raw, accepted: ["none", "preview"], fallback: "preview" });
  return "preview";
}

export interface KnightConfig extends BaseKnightConfig {
  knightModel: string;
  subscribeTopics: string[];
  natsTasksStream: string;
  natsResultsStream: string;
  maxConcurrentTasks: number;
  hostname: string;
  thinkingLevel: ThinkingLevel;
  maxRetryDelayMs: number;
  /** HTTP request timeout for model calls (MODEL_REQUEST_TIMEOUT_MS). Local models can take minutes to a first token. */
  modelRequestTimeoutMs: number;
  thinkingBudgetLow: number;
  thinkingBudgetMedium: number;
  thinkingBudgetHigh: number;
  /** Max persisted session JSONL files kept on the PVC (0 = no count cap). */
  sessionRetentionMaxFiles: number;
  /** Delete persisted session files older than this many days (0 = no age cap). */
  sessionRetentionDays: number;
  /** Task activity event content: `preview` (default) or `none` (no previews / argument summaries). */
  activityContent: "none" | "preview";
  /** Skills directory (KNIGHT_SKILLS_DIR, default /skills): start-up wait, service card and SDK resource loader. */
  skillsDir: string;
}

/** On-disk locations of a pi-knight, all under one data root unless overridden. */
export interface DataPaths {
  /** KNIGHT_DATA_DIR (default /data): SDK cwd and agentDir, session notes, scratch, memory. */
  dataDir: string;
  /** Per-task workspaces: KNIGHT_WORK_ROOT, else <dataDir>/work. */
  workRoot: string;
  /** Persisted session JSONL files: KNIGHT_SESSIONS_ROOT, else <dataDir>/sessions. */
  sessionsRoot: string;
  /** Custom-model catalog: MODELS_JSON_PATH, else <dataDir>/models.json. */
  modelsJson: string;
}

/**
 * Resolve the data paths from the environment. Read on each call (not at import) so env set
 * after import still applies. With KNIGHT_DATA_DIR unset every path is the historical /data one;
 * the specific overrides always take precedence over the data root.
 */
export function dataPaths(env: Env = process.env): DataPaths {
  const dataDir = env["KNIGHT_DATA_DIR"] || "/data";
  return {
    dataDir,
    workRoot: env["KNIGHT_WORK_ROOT"] || join(dataDir, "work"),
    sessionsRoot: env["KNIGHT_SESSIONS_ROOT"] || join(dataDir, "sessions"),
    modelsJson: env["MODELS_JSON_PATH"] || join(dataDir, "models.json"),
  };
}

export function loadConfig(env: Env = process.env): KnightConfig {
  return {
    ...loadBaseConfig(env),
    // Cheap, tool-capable, cache-enabled fleet default. Upgrade individual knights
    // by setting KNIGHT_MODEL on their pod (e.g. openrouter/anthropic/claude-sonnet-4.6).
    knightModel: env["KNIGHT_MODEL"] ?? "openrouter/deepseek/deepseek-v3.2",
    subscribeTopics: parseTopics(requireEnv(env, "SUBSCRIBE_TOPICS")),
    natsTasksStream: env["NATS_TASKS_STREAM"] ?? "fleet_a_tasks",
    natsResultsStream: env["NATS_RESULTS_STREAM"] ?? "fleet_a_results",
    maxConcurrentTasks: maxConcurrentTasks(env),
    hostname: os.hostname(),
    thinkingLevel: thinkingLevelEnv(env),
    // 0 is valid: pi-ai treats it as "no cap" on provider-requested retry delays.
    maxRetryDelayMs: positiveIntEnv(env, "MAX_RETRY_DELAY_MS", 60000, { min: 0 }),
    modelRequestTimeoutMs: positiveIntEnv(env, "MODEL_REQUEST_TIMEOUT_MS", 600000),
    thinkingBudgetLow: positiveIntEnv(env, "THINKING_BUDGET_LOW", 1024),
    thinkingBudgetMedium: positiveIntEnv(env, "THINKING_BUDGET_MEDIUM", 4096),
    thinkingBudgetHigh: positiveIntEnv(env, "THINKING_BUDGET_HIGH", 8192),
    // Each chain run gets its own persisted session (#31); cap how many stay on disk.
    sessionRetentionMaxFiles: positiveIntEnv(env, "SESSION_RETENTION_MAX_FILES", 100, { min: 0 }),
    sessionRetentionDays: nonNegativeFloatEnv(env, "SESSION_RETENTION_DAYS", 30),
    activityContent: activityContentEnv(env),
    skillsDir: env["KNIGHT_SKILLS_DIR"] || "/skills",
  };
}
