import os from "node:os";

/**
 * Runtime configuration. The first block is the env contract the Roundtable
 * operator already sets on every knight pod (see roundtable
 * internal/knight/pod_builder.go) — kept identical to pi-knight so the operator
 * needs no changes. The second block is claude-knight specific and comes from
 * the Knight CR's spec.env / spec.envFrom.
 */
export interface KnightConfig {
  // ── Operator contract (same as pi-knight) ──
  knightName: string;
  knightModel: string;
  subscribeTopics: string[];
  natsUrl: string;
  natsTasksStream: string;
  natsResultsStream: string;
  natsResultsPrefix: string;
  taskTimeoutMs: number;
  /** Max wait for in-flight tasks after SIGTERM. Default taskTimeoutMs + 60s, matching the operator's terminationGracePeriodSeconds. */
  drainTimeoutMs: number;
  maxConcurrentTasks: number;
  metricsPort: number;
  logLevel: string;
  hostname: string;

  // ── claude-knight specific ──
  /** "subscription" (Claude plan via CLAUDE_CODE_OAUTH_TOKEN) or "api" (ANTHROPIC_API_KEY). */
  authMode: AuthMode;
  /**
   * How each task runs: "cli" spawns the official Claude Code CLI headless
   * (`claude -p`); "sdk" calls the Agent SDK's query(). Defaults to cli in
   * subscription mode and sdk in api mode. Subscription + sdk is refused at
   * startup (see checkRuntime in auth.ts).
   */
  runtime: Runtime;
  /** The Claude Code CLI the cli runtime spawns (CLAUDE_BIN, default "claude" on PATH). */
  claudeBin: string;
  /** Model passed to Claude Code; undefined lets Claude Code pick its default. */
  claudeModel: string | undefined;
  /** "low" | "medium" | "high" | "xhigh" | "max" — passed as SDK effort when set. */
  effort: string | undefined;
  /** Cap on agent turns per task (0 = no cap). */
  maxTurns: number;
  /** Per-task budget in USD at API-equivalent prices (0 = no cap). */
  maxBudgetUsd: number;
  /** Working directory for Claude Code (the knight's PVC). */
  workDir: string;
  /** Where Claude Code keeps its config, sessions and linked skills. */
  claudeConfigDir: string;
  /** Read-only skills tree from the skill-filter sidecar: /skills/<category>/<skill>/SKILL.md */
  skillsDir: string;
  /** Personality/config files from the knight ConfigMap. */
  configDir: string;
  /** Extra MCP servers as JSON ({"name": {...McpServerConfig}}), merged with /config/mcp.json. */
  mcpServersJson: string | undefined;
  /** Extra built-in tools to disallow, comma separated. */
  extraDisallowedTools: string[];
  /** "run" (resume within a chain run, fresh otherwise) | "fresh" (every task new). */
  sessionMode: "run" | "fresh";
  /** Stop taking tasks once a plan window is this full (0-1; 1 disables). Subscription mode only. */
  planReserve: number;
}

export type AuthMode = "subscription" | "api";
export type Runtime = "sdk" | "cli";

type Env = NodeJS.ProcessEnv;

function requireEnv(env: Env, name: string): string {
  const val = env[name];
  if (!val) throw new Error(`Required environment variable ${name} is not set`);
  return val;
}

function intEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function floatEnv(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Map the Knight CR's spec.model onto a model Claude Code accepts.
 *
 * The CRD defaults spec.model to "openrouter/deepseek/deepseek-v3.2", so a knight
 * created without a model would otherwise hand Claude Code a model it cannot use.
 * Accepted: Claude Code aliases (sonnet, opus, haiku, fable, …) and claude-* ids,
 * optionally behind an "anthropic/" or "openrouter/anthropic/" prefix. Anything
 * else returns undefined so Claude Code uses the plan's default model.
 * CLAUDE_MODEL, when set, overrides spec.model.
 */
export function resolveClaudeModel(knightModel: string | undefined, override?: string): string | undefined {
  const pick = (override ?? "").trim() || (knightModel ?? "").trim();
  if (!pick) return undefined;
  const stripped = pick.replace(/^(openrouter\/)?anthropic\//i, "");
  if (/^claude-[a-z0-9.-]+$/i.test(stripped)) return stripped.replace(/\./g, "-");
  if (/^(sonnet|opus|haiku|fable|mythos|default|best|opusplan)(\[1m\])?$/i.test(stripped)) return stripped.toLowerCase();
  return undefined;
}

export function loadConfig(env: Env = process.env): KnightConfig {
  const authMode = (env["CLAUDE_AUTH_MODE"] ?? "subscription").toLowerCase();
  if (authMode !== "subscription" && authMode !== "api") {
    throw new Error(`CLAUDE_AUTH_MODE must be "subscription" or "api", got "${authMode}"`);
  }
  const runtime = (env["CLAUDE_RUNTIME"] || (authMode === "subscription" ? "cli" : "sdk")).toLowerCase();
  if (runtime !== "sdk" && runtime !== "cli") {
    throw new Error(`CLAUDE_RUNTIME must be "sdk" or "cli", got "${runtime}"`);
  }
  const sessionMode = (env["CLAUDE_SESSION_MODE"] ?? "run").toLowerCase();
  if (sessionMode !== "run" && sessionMode !== "fresh") {
    throw new Error(`CLAUDE_SESSION_MODE must be "run" or "fresh", got "${sessionMode}"`);
  }
  const knightModel = env["KNIGHT_MODEL"] ?? "";
  const workDir = env["KNIGHT_WORKDIR"] ?? "/data";

  return {
    knightName: requireEnv(env, "KNIGHT_NAME"),
    knightModel,
    subscribeTopics: requireEnv(env, "SUBSCRIBE_TOPICS").split(",").map((s) => s.trim()).filter(Boolean),
    natsUrl: env["NATS_URL"] ?? "nats://nats.database.svc.cluster.local:4222",
    natsTasksStream: env["NATS_TASKS_STREAM"] ?? "fleet_a_tasks",
    natsResultsStream: env["NATS_RESULTS_STREAM"] ?? "fleet_a_results",
    natsResultsPrefix: env["NATS_RESULTS_PREFIX"] ?? "fleet-a.results",
    taskTimeoutMs: intEnv(env, "TASK_TIMEOUT_MS", 1_800_000),
    drainTimeoutMs: intEnv(env, "DRAIN_TIMEOUT_MS", intEnv(env, "TASK_TIMEOUT_MS", 1_800_000) + 60_000),
    // The operator always sets this from spec.concurrency (CRD default 2). Set
    // concurrency: 1 on claude-knights unless the plan has headroom to spare.
    maxConcurrentTasks: Math.max(1, intEnv(env, "MAX_CONCURRENT_TASKS", 1)),
    metricsPort: intEnv(env, "METRICS_PORT", 3000),
    logLevel: env["LOG_LEVEL"] ?? "info",
    hostname: os.hostname(),

    authMode,
    runtime,
    claudeBin: env["CLAUDE_BIN"] || "claude",
    claudeModel: resolveClaudeModel(knightModel, env["CLAUDE_MODEL"]),
    effort: env["CLAUDE_EFFORT"] || undefined,
    maxTurns: intEnv(env, "CLAUDE_MAX_TURNS", 0),
    maxBudgetUsd: floatEnv(env, "CLAUDE_MAX_BUDGET_USD", 0),
    workDir,
    claudeConfigDir: env["CLAUDE_CONFIG_DIR"] ?? `${workDir}/.claude-home`,
    skillsDir: env["KNIGHT_SKILLS_DIR"] ?? "/skills",
    configDir: env["KNIGHT_CONFIG_DIR"] ?? "/config",
    mcpServersJson: env["MCP_SERVERS_JSON"] || undefined,
    extraDisallowedTools: (env["CLAUDE_DISALLOWED_TOOLS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    sessionMode: sessionMode as "run" | "fresh",
    planReserve: Math.min(1, Math.max(0, floatEnv(env, "CLAUDE_PLAN_RESERVE", 0.8))),
  };
}
