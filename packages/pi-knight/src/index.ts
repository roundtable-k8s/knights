import { loadConfig } from "./config.js";
import { migrateMemory, ensureMemoryDirs, resolveMemoryPaths, initLogger, log, connectNats, startIntrospect, subscribe, publishResult, drain, HEARTBEAT_MS, natsPrefix, podIdentity, scrubAgentEnv, TaskActivity, SlotPool, promptWithRetryContext, invalidTaskResult, lostTaskResult, type TaskDelivery, handleIntrospect, introspectRequestFromQuery, createShutdown, installStartupSignalHandlers, startHealthServer, stopHealthServer, setSkillCount, setActiveTaskCount, setDegradedReason, setDraining, getConnection, startKnightService, tableName, domainFromTopics, countsFromMetrics, readPackageVersion, initRoster, startTelemetry, withTaskSpan, type KnightService } from "@roundtable/knight-core";
import { hostname } from "node:os";
import { skillsExpected, waitForSkills } from "./skill-wait.js";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { executeTask, getActiveSessions, pruneOldSessions, warmSession } from "./knight.js";
import { introspectOptions } from "./session-source.js";
import { resolveModel } from "./model.js";
import { buildResultPayload, failedTaskResult } from "./task-payload.js";
import { preflightModelUntilReady } from "./preflight.js";
import * as metrics from "./runtime-metrics.js";

async function main(): Promise<void> {
  // pi's bash tool spawns from process.env: keep production-mode switches out of agent shells.
  scrubAgentEnv();
  const config = loadConfig();
  initLogger(config.knightName, config.logLevel, config.table);
  // Signal handlers before any network call: a pod deleted during start-up exits now
  // (closing what is open) instead of starting up and taking tasks (see startup-signals.ts).
  // eslint-disable-next-line prefer-const -- the start-up handlers close it, and can run before it is assigned
  let telemetry: Awaited<ReturnType<typeof startTelemetry>> | undefined;
  const signals = installStartupSignalHandlers({
    cleanup: async () => {
      await drain().catch((e) => log.error("NATS drain error", { error: String(e) }));
      await stopHealthServer();
      await telemetry?.shutdown();
    },
    exit: (code) => process.exit(code),
  });
  telemetry = await startTelemetry({ service: "pi-knight", knight: config.knightName, table: config.table });
  migrateMemory({ memoryDir: config.memoryDir });
  ensureMemoryDirs(resolveMemoryPaths({ memoryDir: config.memoryDir, memoryRoot: config.memoryRoot }));

  log.info("Pi-Knight starting", {
    model: config.knightModel,
    topics: config.subscribeTopics,
    thinking: config.thinkingLevel,
  });

  // Start health/metrics HTTP server
  startHealthServer({
    knightName: config.knightName,
    port: config.metricsPort,
    registry: metrics.registry,
    readyExtras: () => ({ model: config.knightModel }),
    routes: { "/introspect": (url) => handleIntrospect(introspectRequestFromQuery(url.searchParams), introspectOptions(config)) },
  });
  log.info("Health server started", { port: config.metricsPort });

  // Preflight the model endpoint before doing anything else. For local endpoints
  // (Ollama/LM Studio/LiteLLM) this catches an unreachable endpoint or missing
  // model and warns on Ollama context-truncation footguns; cloud endpoints are a no-op.
  // An unreachable endpoint used to exit fatally → CrashLoopBackOff; now the knight
  // stays up and degraded (readiness 503 with the reason, /health still 200 so the
  // startup probe passes) and retries with capped backoff until the endpoint answers.
  // Resolving here is throwaway (knight.ts re-resolves for the session) but shares the
  // same baseUrl/default logic, so what we probe is exactly what the session will use.
  await preflightModelUntilReady((await resolveModel(config.knightModel)).model, {
    onAttemptFailed: (error) => setDegradedReason(`model preflight failed: ${error}`),
  });
  setDegradedReason(null);

  // Discover skills using Pi SDK's built-in agentskills.io loader
  // Retry for git-sync race at startup
  const skillCount = await waitForSkills({
    maxAttempts: 20, // ~60s total — allows git-sync + skill-filter to complete
    intervalMs: 3000,
    expected: skillsExpected(),
    info: (msg, data) => log.info(msg, data),
    load: () => {
      const { skills, diagnostics } = loadSkills({
        cwd: "/data",
        agentDir: "/config",
        skillPaths: ["/skills"],
        includeDefaults: true,
      });
      if (skills.length > 0) {
        log.info("Skills loaded (Pi SDK)", {
          count: skills.length,
          names: skills.map((s) => s.name),
        });
        for (const d of diagnostics) {
          if (d.type === "warning") log.warn("Skill diagnostic", { message: d.message, path: d.path });
        }
      }
      return skills.length;
    },
  });
  setSkillCount(skillCount);

  // Pre-warm the agent session in the background (after skills so the session
  // snapshot includes them, before task subscribe so cold-start latency —
  // observed 79s with PVC history — lands here, not in the first task's window).
  warmSession(config);
  // Apply session-file retention once at startup; it runs again on every run change.
  pruneOldSessions(config);

  // Connect to NATS
  await connectNats(config, `pi-knight-${config.knightName}`, metrics.setNatsConnected);

  // Agent-card roster for find_knights / nats_request by name: a KV watch on <table>.* (none without KNIGHT_CARDS_BUCKET).
  void initRoster(process.env, config.knightName, getConnection)?.start();

  // Start introspection responder (zero-cost session queries)
  startIntrospect({ ...introspectOptions(config), prefix: natsPrefix(config) });

  // Register as a NATS micro service ($SRV.PING/INFO/STATS) for liveness, skills and load.
  // Discovery only: tasks stay on JetStream.
  let activeCount = 0;
  let knightService: KnightService | null = null;
  const nc = getConnection();
  if (nc) {
    knightService = await startKnightService({
      nc,
      knightName: config.knightName,
      table: tableName(process.env, config),
      domain: domainFromTopics(config.subscribeTopics),
      model: config.knightModel,
      runtime: "pi-knight",
      version: readPackageVersion(import.meta.url),
      pod: config.hostname,
      skillsDir: "/skills",
      maxConcurrentTasks: config.maxConcurrentTasks,
      getActive: () => activeCount,
      getCounts: () => countsFromMetrics(metrics.tasksTotal, config.knightName),
    }).catch((e) => {
      log.warn("NATS micro service registration failed", { error: String(e) });
      return null;
    });
  }

  // Subscribe to task stream

  // Task execution state
  let puller: Awaited<ReturnType<typeof subscribe>> | null = null;
  let shuttingDown = false;
  // Concurrency slots (0-based) in use, reported on task.started.
  const slots = new SlotPool();

  // Process a single task
  async function processTask(delivery: TaskDelivery): Promise<void> {
    // Skills may have changed (git-sync): re-read and re-register the service if so.
    // Not awaited: the slot must be counted synchronously so the next fetch sees it.
    void knightService?.refreshSkills();
    const { taskId, runId, model, chainName, stepName, timestamp, attempt } = delivery.task;
    const taskText = promptWithRetryContext(delivery.task);
    const timeoutMs = delivery.task.timeoutMs ?? config.taskTimeoutMs;
    const slot = slots.acquire();
    const sentAt = timestamp ? Date.parse(timestamp) : NaN;
    const activity = new TaskActivity({
      knight: config.knightName,
      table: config.table,
      prefix: natsPrefix(config),
      taskId,
      identity: podIdentity(process.env, hostname()),
      runId,
      chainName,
      stepName,
      model: model ?? config.knightModel,
      slot,
      attempt,
      concurrency: config.maxConcurrentTasks,
      ...(Number.isFinite(sentAt) ? { queuedFor: Math.max(0, Date.now() - sentAt) } : {}),
      content: config.activityContent,
    });
    // Keep the message un-acked but alive while the task runs; ack only when it finishes.
    const heartbeat = setInterval(() => {
      delivery.working();
      activity.heartbeat();
    }, HEARTBEAT_MS);
    activeCount++;
    activity.started();
    setActiveTaskCount(activeCount);
    metrics.activeTasks.labels().set(activeCount);

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await withTaskSpan(
        { taskId, runId, attempt, knight: config.knightName, table: config.table, model: model ?? config.knightModel },
        () => executeTask(taskText, config, controller.signal, runId, taskId, { model, activity }),
        (r) => ({ success: r.success, cost: r.cost, model: r.model, error: r.error }),
      );
      const durationMs = Date.now() - startTime;

      activity.finished({ success: result.success, error: result.error, cost: result.cost, tokens: result.tokens });

      // Metrics first: a result that cannot be published must not lose them or turn a success into an error. (#91)
      // Token/cost are recorded regardless — a no-output task still spent them. Only the
      // task-outcome counter reflects the honest success/failure. (#31)
      metrics.tasksTotal.labels(result.success ? "success" : "error").inc();
      metrics.taskDuration.labels().observe(durationMs / 1000);
      metrics.llmCost.labels(result.model, metrics.BILLING).inc(result.cost);
      metrics.recordTokens(result.model, result.tokens);

      try {
        await publishResult(taskId, buildResultPayload(result, { taskId, knight: config.knightName, durationMs, parsed: delivery.task }));
      } catch (e) {
        // Do not publish a made-up failure for a task that ran: the real result is lost, say so.
        log.error("Failed to publish task result — result lost", { taskId, error: e instanceof Error ? e.message : String(e) });
        metrics.tasksTotal.labels("publish_failed").inc();
      }
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Task failed", { taskId, error: errMsg });
      activity.finished({ success: false, error: errMsg });

      await publishResult(taskId, buildResultPayload(
        failedTaskResult(errMsg, config.knightModel),
        { taskId, knight: config.knightName, durationMs, parsed: delivery.task },
      )).catch((e) => log.error("Failed to publish error result", { error: String(e) }));

      metrics.tasksTotal.labels("error").inc();
      metrics.taskDuration.labels().observe(durationMs / 1000);
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      activity.close();
      knightService?.markTaskFinished();
      slots.release(slot);
      delivery.ack();
      activeCount--;
      setActiveTaskCount(activeCount);
      metrics.activeTasks.labels().set(activeCount);
      puller?.wake();
    }
  }

  // Graceful shutdown (sequence lives in drain.ts so tests run the real thing)
  const shutdown = createShutdown({
    setDraining: (d) => {
      shuttingDown = d; // freeSlots() -> 0: no new fetches
      setDraining(d);
    },
    stopService: () => knightService?.stop(),
    stopPulling: async () => void (await puller?.stop()),
    getActive: () => activeCount,
    maxWaitMs: config.drainTimeoutMs,
    // Dispose sessions to abort in-flight agent/compaction/retry/bash work.
    abortInflight: () => {
      for (const s of getActiveSessions()) {
        try {
          s.dispose();
        } catch (e) {
          log.error("Session dispose error", { error: String(e) });
        }
      }
    },
    drainNats: drain,
    cleanup: async () => {
      metrics.natsConnected.labels().set(0);
      await stopHealthServer();
      await telemetry?.shutdown();
    },
    exit: (code) => process.exit(code),
  });
  // Ready: later signals run the full shutdown above. If one came during start-up the
  // start-up exit is already running: do not start the pull loop.
  if (!signals.ready(shutdown)) return;

  // Pull only when a slot is free; backlog stays in the stream (consumer lag), not in memory.
  puller = await subscribe(config, {
    // Guard: never fetch once a termination was requested, even one that came during start-up.
    freeSlots: () => (shuttingDown || signals.requested() !== null ? 0 : config.maxConcurrentTasks - activeCount),
    // Skip self-echo — ignore messages published by this knight back to its own topic
    accept: (parsed) => {
      const self = !!parsed.from && parsed.from.toLowerCase() === config.knightName.toLowerCase();
      if (self) log.debug("Skipping self-echo", { taskId: parsed.taskId, from: parsed.from });
      return !self;
    },
    onTask: (delivery) => {
      void processTask(delivery);
    },
    onLost: async (parsed) => {
      metrics.recordLostTask();
      await publishResult(parsed.taskId, lostTaskResult({ taskId: parsed.taskId, knight: config.knightName, model: config.knightModel, parsed }));
    },
    // A payload that breaks the TaskPayload schema: answer with a failure naming the field.
    onInvalid: async (parsed) => {
      metrics.tasksTotal.labels("error").inc();
      await publishResult(parsed.taskId, invalidTaskResult({
        taskId: parsed.taskId,
        knight: config.knightName,
        model: config.knightModel,
        invalid: parsed.invalid ?? "invalid",
      }));
    },
  });

  log.info("Pi-Knight ready");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
