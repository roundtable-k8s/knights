import os from "node:os";
import { loadBaseConfig, requireEnv, type BaseKnightConfig, type Env } from "@roundtable/knight-core";

export interface KnightConfig extends BaseKnightConfig {
  knightModel: string;
  subscribeTopics: string[];
  natsTasksStream: string;
  natsResultsStream: string;
  maxConcurrentTasks: number;
  hostname: string;
  thinkingLevel: string;
  maxRetryDelayMs: number;
  thinkingBudgetLow: number;
  thinkingBudgetMedium: number;
  thinkingBudgetHigh: number;
  /** Max persisted session JSONL files kept on the PVC (0 = no count cap). */
  sessionRetentionMaxFiles: number;
  /** Delete persisted session files older than this many days (0 = no age cap). */
  sessionRetentionDays: number;
  /** Task activity event content: `preview` (default) or `none` (no previews / argument summaries). */
  activityContent: "none" | "preview";
}

export function loadConfig(env: Env = process.env): KnightConfig {
  return {
    ...loadBaseConfig(env),
    // Cheap, tool-capable, cache-enabled fleet default. Upgrade individual knights
    // by setting KNIGHT_MODEL on their pod (e.g. openrouter/anthropic/claude-sonnet-4.6).
    knightModel: env["KNIGHT_MODEL"] ?? "openrouter/deepseek/deepseek-v3.2",
    subscribeTopics: requireEnv(env, "SUBSCRIBE_TOPICS").split(",").map((s) => s.trim()),
    natsTasksStream: env["NATS_TASKS_STREAM"] ?? "fleet_a_tasks",
    natsResultsStream: env["NATS_RESULTS_STREAM"] ?? "fleet_a_results",
    maxConcurrentTasks: parseInt(env["MAX_CONCURRENT_TASKS"] ?? "2", 10),
    hostname: os.hostname(),
    thinkingLevel: env["KNIGHT_THINKING"] ?? "off",
    maxRetryDelayMs: parseInt(env["MAX_RETRY_DELAY_MS"] ?? "60000", 10),
    thinkingBudgetLow: parseInt(env["THINKING_BUDGET_LOW"] ?? "1024", 10),
    thinkingBudgetMedium: parseInt(env["THINKING_BUDGET_MEDIUM"] ?? "4096", 10),
    thinkingBudgetHigh: parseInt(env["THINKING_BUDGET_HIGH"] ?? "8192", 10),
    // Each chain run gets its own persisted session (#31); cap how many stay on disk.
    sessionRetentionMaxFiles: parseInt(env["SESSION_RETENTION_MAX_FILES"] ?? "100", 10),
    sessionRetentionDays: parseFloat(env["SESSION_RETENTION_DAYS"] ?? "30"),
    activityContent: env["ACTIVITY_CONTENT"] === "none" ? "none" : "preview",
  };
}
