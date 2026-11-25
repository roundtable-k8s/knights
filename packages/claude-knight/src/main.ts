import { basename } from "node:path";
import { hostname } from "node:os";
import { checkAuth, checkRuntime } from "./auth.js";
import { loadConfig, planReserveFromEnv, type KnightConfig } from "./config.js";
import { introspectOptions } from "./session-source.js";
import { executeTask, sweepStaleWorkDirs } from "./knight.js";
import { buildResultPayload, failedOutcome, reserveRefusedOutcome, runtimeFields } from "./result.js";
import { migrateMemory, ensureMemoryDirs, resolveMemoryPaths, initLogger, log, connectNats, startIntrospect, drain, HEARTBEAT_MS, natsPrefix, podIdentity, invalidTaskResult, lostTaskResult, publishResult, subscribe, TaskActivity, promptWithRetryContext, type TaskDelivery, handleIntrospect, introspectRequestFromQuery, createShutdown, installSignalHandlers, setActiveTaskCount, setDegradedReason, setDraining, setSkillCount, startHealthServer, stopHealthServer, getConnection, startKnightService, tableName, domainFromTopics, countsFromMetrics, readPackageVersion, initRoster, type KnightService } from "@roundtable/knight-core";
import * as metrics from "./runtime-metrics.js";
import { checkReserveRefreshing } from "./plan-limits.js";
import { linkSkills } from "./skills.js";
import { configureTools } from "./tools.js";

/**
 * Cheapest call that returns a fresh rate-limit reading: a one-word prompt on the
 * smallest model. Its rate_limit_event updates the stored plan windows via the stream.
 */
async function probeUsage(config: KnightConfig): Promise<void> {
  const r = await executeTask("Reply with the single word: ok", "plan-usage-probe", config, AbortSignal.timeout(60_000), undefined, { model: "haiku" });
  if (!r.success && !r.usageLimited) throw new Error(r.error ?? "usage probe failed");
}

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
  initLogger(config.knightName, config.logLevel, config.table);
  migrateMemory({ memoryDir: config.memoryDir, dataDir: config.workDir });
  ensureMemoryDirs(resolveMemoryPaths({ memoryDir: config.memoryDir, memoryRoot: config.memoryRoot, dataDir: config.workDir }));
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

  startHealthServer({
    knightName: config.knightName,
    port: config.metricsPort,
    registry: metrics.registry,
    readyExtras: () => ({
      model: config.claudeModel ?? "claude-code-default",
      runtime: "claude-knight",
      claudeRuntime: config.runtime,
      billing: config.authMode,
    }),
    routes: { "/introspect": (url) => handleIntrospect(introspectRequestFromQuery(url.searchParams), introspectOptions(config)) },
  });

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

  await connectNats(config, `claude-knight-${config.knightName}`);
  metrics.natsConnected.labels().set(1);
  startIntrospect({ ...introspectOptions(config), prefix: natsPrefix(config) });
  // Agent-card roster for find_knights / nats_request by name: a KV watch on <table>.* (none without KNIGHT_CARDS_BUCKET).
  void initRoster(process.env, config.knightName, getConnection)?.start();

  let activeCount = 0;
  // Register as a NATS micro service ($SRV.PING/INFO/STATS) for liveness, skills and load.
  // Discovery only: tasks stay on JetStream.
  let knightService: KnightService | null = null;
  const nc = getConnection();
  if (nc) {
    knightService = await startKnightService({
      nc,
      knightName: config.knightName,
      table: tableName(process.env, config),
      domain: domainFromTopics(config.subscribeTopics),
      model: config.claudeModel ?? "claude-code-default",
      runtime: "claude-knight",
      version: readPackageVersion(import.meta.url),
      pod: config.podName,
      skillsDir: config.skillsDir,
      maxConcurrentTasks: config.maxConcurrentTasks,
      getActive: () => activeCount,
      getCounts: () => countsFromMetrics(metrics.tasksTotal, config.knightName),
    }).catch((e) => {
      log.warn("NATS micro service registration failed", { error: String(e) });
      return null;
    });
  }
  let shuttingDown = false;
  let puller: Awaited<ReturnType<typeof subscribe>> | null = null;

  const setActive = (n: number) => {
    activeCount = n;
    setActiveTaskCount(n);
    metrics.activeTasks.labels().set(n);
  };

  async function processTask(delivery: TaskDelivery): Promise<void> {
    const parsed = delivery.task;
    // Skills may have changed (git-sync): re-read and re-register the service if so.
    // Not awaited: the slot must be counted synchronously so the next fetch sees it.
    void knightService?.refreshSkills();
    // Keep the message un-acked but alive while the task runs; ack only when it finishes.
    const started = Date.now();
    const activity = new TaskActivity({
      knight: config.knightName,
      table: config.table,
      prefix: natsPrefix(config),
      taskId: parsed.taskId,
      identity: podIdentity(process.env, hostname()),
      runId: parsed.runId,
      chainName: parsed.chainName,
      stepName: parsed.stepName,
      attempt: parsed.attempt,
      model: parsed.model ?? config.claudeModel,
      slot: activeCount,
      concurrency: config.maxConcurrentTasks,
      queuedFor: parsed.publishedAtMs ? Math.max(0, started - parsed.publishedAtMs) : undefined,
      workDir: basename(config.workDir),
      content: config.activityContent,
    });
    activity.started();
    const heartbeat = setInterval(() => {
      delivery.working();
      activity.heartbeat();
    }, HEARTBEAT_MS);
    setActive(activeCount + 1);
    const timeoutMs = parsed.timeoutMs ?? config.taskTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Plan reserve: refuse new work before spawning Claude Code at all.
      const reserve: { blocked: boolean; reason?: string } =
        config.authMode === "subscription"
          ? await checkReserveRefreshing(planReserveFromEnv(), () => probeUsage(config), {
              onCleared: () => log.info("Plan reserve cleared: usage is back under the reserve, accepting tasks"),
            })
          : { blocked: false };
      const outcome = reserve.blocked
        ? null
        : await executeTask(promptWithRetryContext(parsed), parsed.taskId, config, controller.signal, parsed.runId, { model: parsed.model });

      if (!outcome) {
        log.warn("Task refused: plan reserve", { taskId: parsed.taskId, reason: reserve.reason });
        activity.finished({ success: false, error: `Task refused: ${reserve.reason}`, errorClass: "model_error", cost: 0 });
        metrics.usageLimitHits.labels().inc();
        metrics.tasksTotal.labels("refused").inc();
        await publishResult(
          parsed.taskId,
          buildResultPayload(reserveRefusedOutcome(reserve.reason, config), {
            taskId: parsed.taskId,
            knight: config.knightName,
            durationMs: Date.now() - started,
            parsed,
          }),
        );
        return;
      }

      const durationMs = Date.now() - started;
      activity.finished({ success: outcome.success, error: outcome.error, errorClass: outcome.usageLimited ? "model_error" : undefined, cost: outcome.cost, tokens: outcome.tokens, turns: outcome.turns });
      await publishResult(parsed.taskId, buildResultPayload(outcome, { taskId: parsed.taskId, knight: config.knightName, durationMs, parsed }));

      metrics.tasksTotal.labels(outcome.success ? "success" : "error").inc();
      metrics.taskDuration.labels().observe(durationMs / 1000);
      metrics.llmCost.labels(outcome.model, outcome.billing).inc(outcome.cost);
      metrics.recordTokens(outcome.model, outcome.tokens);
      if (outcome.usageLimited) metrics.usageLimitHits.labels().inc();
    } catch (err) {
      const durationMs = Date.now() - started;
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Task failed", { taskId: parsed.taskId, error: errMsg });
      activity.finished({ success: false, error: errMsg, errorClass: "internal", cost: 0 });
      await publishResult(
        parsed.taskId,
        buildResultPayload(failedOutcome(errMsg, config), { taskId: parsed.taskId, knight: config.knightName, durationMs, parsed }),
      ).catch((e) => log.error("Failed to publish error result", { error: String(e) }));

      metrics.tasksTotal.labels("error").inc();
      metrics.taskDuration.labels().observe(durationMs / 1000);
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      activity.close();
      knightService?.markTaskFinished();
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
      metrics.recordLostTask();
      const model = config.claudeModel ?? "claude-code-default";
      await publishResult(parsed.taskId, {
        ...lostTaskResult({ taskId: parsed.taskId, knight: config.knightName, model, parsed }),
        ...runtimeFields(config),
      });
    },
    // A payload that breaks the TaskPayload schema: answer with a failure naming the field.
    onInvalid: async (parsed) => {
      metrics.tasksTotal.labels("error").inc();
      const model = config.claudeModel ?? "claude-code-default";
      await publishResult(parsed.taskId, {
        ...invalidTaskResult({ taskId: parsed.taskId, knight: config.knightName, model, invalid: parsed.invalid ?? "invalid" }),
        ...runtimeFields(config),
      });
    },
  });

  const shutdown = createShutdown({
    setDraining: (d) => {
      shuttingDown = d; // freeSlots() -> 0: no new fetches
      setDraining(d);
    },
    stopService: () => knightService?.stop(),
    stopPulling: async () => void (await puller?.stop()),
    getActive: () => activeCount,
    maxWaitMs: config.drainTimeoutMs,
    drainNats: drain,
    cleanup: async () => {
      metrics.natsConnected.labels().set(0);
      await stopHealthServer();
    },
    exit: (code) => process.exit(code),
  });
  installSignalHandlers(shutdown);

  log.info("Claude-Knight ready");
}
