import { checkAuth, checkRuntime } from "./auth.js";
import { loadConfig, type KnightConfig } from "./config.js";
import { setActiveTaskCount, setDegradedReason, setSkillCount, startHealthServer, stopHealthServer } from "./health.js";
import { setIntrospectActiveTasks, startIntrospect } from "./introspect.js";
import { executeTask, sweepStaleWorkDirs } from "./knight.js";
import { initLogger, log } from "./logger.js";
import * as metrics from "./metrics.js";
import { connectNats, drain, HEARTBEAT_MS, publishResult, subscribe, type TaskDelivery } from "./nats.js";
import { checkReserve } from "./plan-limits.js";
import { linkSkills } from "./skills.js";
import { configureTools } from "./tools.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForSkills(config: KnightConfig): Promise<number> {
  // Same git-sync race pi-knight handles: the skill-filter sidecar links
  // categories a few seconds after start. ~60s, then go on without skills.
  for (let attempt = 0; attempt < 20; attempt++) {
    const { names } = linkSkills(config.skillsDir, config.claudeConfigDir);
    if (names.length > 0) {
      log.info("Skills available", { count: names.length, names });
      return names.length;
    }
    if (attempt < 19) await sleep(3000);
  }
  log.warn("No skills found after waiting for git-sync — continuing without", { skillsDir: config.skillsDir });
  return 0;
}

export async function main(): Promise<void> {
  const config = loadConfig();
  initLogger(config.knightName, config.logLevel);
  // Introspect in this process reads the same config dir the Claude Code child
  // processes write to.
  process.env["CLAUDE_CONFIG_DIR"] = config.claudeConfigDir;
  sweepStaleWorkDirs(config);

  log.info("Claude-Knight starting", {
    model: config.claudeModel ?? "claude-code-default",
    specModel: config.knightModel || null,
    authMode: config.authMode,
    runtime: config.runtime,
    sessionMode: config.sessionMode,
    topics: config.subscribeTopics,
    concurrency: config.maxConcurrentTasks,
    planReserve: config.authMode === "subscription" ? config.planReserve : null,
  });
  if (config.knightModel && !config.claudeModel) {
    log.warn("spec.model is not a Claude model — using Claude Code's default model", { specModel: config.knightModel });
  }

  startHealthServer(config);

  // A missing credential can only be fixed by changing the Secret, which restarts
  // the pod. Stay up and degraded (readiness 503 with the reason) and do NOT bind
  // the consumer, so tasks wait in the stream instead of failing one by one.
  const auth = checkAuth(config.authMode);
  for (const w of auth.warnings) log.warn(w);
  const runtimeProblem = checkRuntime(config.authMode, config.runtime);
  if (!auth.ok || runtimeProblem) {
    const reason = auth.ok ? `runtime: ${runtimeProblem}` : `auth: ${auth.reason}`;
    log.error("Startup check failed — knight will stay degraded", { reason });
    setDegradedReason(reason);
    await new Promise(() => {}); // park; SIGTERM still exits via default handler
  }

  configureTools(config.knightName, config.natsResultsPrefix);
  setSkillCount(await waitForSkills(config));

  await connectNats(config);
  metrics.natsConnected.labels(config.knightName).set(1);
  startIntrospect(config);

  let activeCount = 0;
  let shuttingDown = false;
  let puller: Awaited<ReturnType<typeof subscribe>> | null = null;

  const setActive = (n: number) => {
    activeCount = n;
    setActiveTaskCount(n);
    setIntrospectActiveTasks(n);
    metrics.activeTasks.labels(config.knightName).set(n);
  };

  async function processTask(delivery: TaskDelivery): Promise<void> {
    const parsed = delivery.task;
    // Keep the message un-acked but alive while the task runs; ack only when it finishes.
    const heartbeat = setInterval(() => delivery.working(), HEARTBEAT_MS);
    setActive(activeCount + 1);
    const started = Date.now();
    const timeoutMs = parsed.timeoutMs ?? config.taskTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Plan reserve: refuse new work before spawning Claude Code at all.
      const reserve = config.authMode === "subscription" ? checkReserve(config.planReserve) : { blocked: false };
      const outcome = reserve.blocked
        ? null
        : await executeTask(parsed.task, parsed.taskId, config, controller.signal, parsed.runId, { model: parsed.model });

      if (!outcome) {
        log.warn("Task refused: plan reserve", { taskId: parsed.taskId, reason: reserve.reason });
        metrics.usageLimitHits.labels(config.knightName).inc();
        metrics.tasksTotal.labels(config.knightName, "refused").inc();
        await publishResult(parsed.taskId, {
          task_id: parsed.taskId,
          knight: config.knightName,
          success: false,
          result: `Task refused: ${reserve.reason}`,
          error: `Task refused: ${reserve.reason}`,
          usage_limited: true,
          duration_ms: Date.now() - started,
          cost: 0,
          tokens: { input: 0, output: 0 },
          model: config.claudeModel ?? "claude-code-default",
          runtime: "claude-knight",
          billing: config.authMode,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const durationMs = Date.now() - started;
      await publishResult(parsed.taskId, {
        task_id: parsed.taskId,
        knight: config.knightName,
        success: outcome.success,
        result: outcome.result,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.usageLimited ? { usage_limited: true } : {}),
        duration_ms: durationMs,
        cost: outcome.cost,
        tokens: outcome.tokens,
        model: outcome.model,
        turns: outcome.turns,
        runtime: "claude-knight",
        billing: outcome.billing,
        timestamp: new Date().toISOString(),
      });

      metrics.tasksTotal.labels(config.knightName, outcome.success ? "success" : "error").inc();
      metrics.taskDuration.labels(config.knightName).observe(durationMs / 1000);
      metrics.llmCost.labels(config.knightName, outcome.model, outcome.billing).inc(outcome.cost);
      metrics.tokensTotal.labels(config.knightName, "input").inc(outcome.tokens.input);
      metrics.tokensTotal.labels(config.knightName, "output").inc(outcome.tokens.output);
      metrics.tokensTotal.labels(config.knightName, "cached").inc(outcome.tokens.cacheRead);
      if (outcome.usageLimited) metrics.usageLimitHits.labels(config.knightName).inc();
    } catch (err) {
      const durationMs = Date.now() - started;
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Task failed", { taskId: parsed.taskId, error: errMsg });
      await publishResult(parsed.taskId, {
        task_id: parsed.taskId,
        knight: config.knightName,
        success: false,
        result: `Task failed: ${errMsg}`,
        error: errMsg,
        duration_ms: durationMs,
        cost: 0,
        tokens: { input: 0, output: 0 },
        model: config.claudeModel ?? "claude-code-default",
        runtime: "claude-knight",
        billing: config.authMode,
        timestamp: new Date().toISOString(),
      }).catch((e) => log.error("Failed to publish error result", { error: String(e) }));
      metrics.tasksTotal.labels(config.knightName, "error").inc();
      metrics.taskDuration.labels(config.knightName).observe(durationMs / 1000);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      delivery.ack();
      setActive(activeCount - 1);
      puller?.wake();
    }
  }

  // Pull only when a slot is free; backlog stays in the stream (consumer lag), not in memory.
  puller = await subscribe(config, {
    freeSlots: () => (shuttingDown ? 0 : config.maxConcurrentTasks - activeCount),
    accept: (parsed) => {
      const self = !!parsed.from && parsed.from.toLowerCase() === config.knightName.toLowerCase();
      if (self) log.debug("Skipping self-echo", { taskId: parsed.taskId });
      return !self;
    },
    onTask: (delivery) => {
      // Count the slot synchronously so the next fetch sees it.
      void processTask(delivery);
    },
    onLost: async (parsed) => {
      const msg = "Task was delivered to a knight that stopped before finishing it (not re-run: max_deliver=1)";
      metrics.tasksTotal.labels(config.knightName, "error").inc();
      await publishResult(parsed.taskId, {
        task_id: parsed.taskId,
        knight: config.knightName,
        success: false,
        result: `Task failed: ${msg}`,
        error: msg,
        lost: true,
        duration_ms: 0,
        cost: 0,
        tokens: { input: 0, output: 0 },
        model: config.claudeModel ?? "claude-code-default",
        runtime: "claude-knight",
        billing: config.authMode,
        timestamp: new Date().toISOString(),
      });
    },
  });

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("Shutdown signal received", { signal, activeCount });
    const deadline = Date.now() + 60_000;
    while (activeCount > 0 && Date.now() < deadline) await sleep(1000);
    if (activeCount > 0) log.warn("Forcing shutdown with active tasks", { activeCount });
    await drain().catch((e) => log.error("NATS drain error", { error: String(e) }));
    metrics.natsConnected.labels(config.knightName).set(0);
    await stopHealthServer();
    log.info("Shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log.info("Claude-Knight ready");
}
