import { basename } from "node:path";
import { hostname } from "node:os";
import { checkAuth, checkRuntime } from "./auth.js";
import { loadConfig, planReserveFromEnv, type KnightConfig } from "./config.js";
import { introspectOptions } from "./session-source.js";
import { executeTask, sweepStaleWorkDirs } from "./knight.js";
import { buildResultPayload, failedOutcome, invalidResultPayload, lostResultPayload } from "./result.js";
import { refuseForReserve } from "./reserve-refusal.js";
import { ShutdownAbort, setupMemory, initLogger, log, connectNats, startIntrospect, drain, natsPrefix, podIdentity, publishResult, publishTaskOutcome, startTaskScope, createActiveCounter, type TaskScope, subscribe, TaskActivity, SlotPool, isSelfEcho, runInSlot, promptWithRetryContext, withTaskLimitNote, type TaskDelivery, handleIntrospect, introspectRequestFromQuery, createShutdown, installStartupSignalHandlers, mayPullAfterSweep, installProcessErrorHandlers, setActiveTaskCount, setDegradedReason, setDraining, setSkillCount, startHealthServer, stopHealthServer, getConnection, startKnightService, tableName, domainFromTopics, countsFromMetrics, readPackageVersion, startTelemetry, withTaskSpan, traceIdFromTraceparent, traceHeaders, activeTraceId, type KnightService } from "@roundtable/knight-core";
import { startParentRoster } from "./parent-roster.js";
import * as metrics from "./runtime-metrics.js";
import { recordPublishFailed, recordTaskOutcome } from "./task-metrics.js";
import { checkReserveRefreshing } from "./plan-limits.js";
import { waitForSkills } from "./skills.js";
import { configureTools } from "./tools.js";

/**
 * Cheapest call that returns a fresh rate-limit reading: a one-word prompt on the
 * smallest model. Its rate_limit_event updates the stored plan windows via the stream.
 */
async function probeUsage(config: KnightConfig): Promise<void> {
  const r = await executeTask("Reply with the single word: ok", "plan-usage-probe", config, AbortSignal.timeout(60_000), undefined, { model: "haiku" });
  if (!r.success && !r.usageLimited) throw new Error(r.error ?? "usage probe failed");
}

export async function main(): Promise<void> {
  const config = loadConfig();
  initLogger(config.knightName, config.logLevel, config.table);
  installProcessErrorHandlers();
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
  telemetry = await startTelemetry({ service: "claude-knight", knight: config.knightName, table: config.table });
  setupMemory(config, config.workDir, setDegradedReason);
  // Introspect in this process reads the same config dir the Claude Code child
  // processes write to.
  process.env["CLAUDE_CONFIG_DIR"] = config.claudeConfigDir;
  // Not awaited here: it overlaps the skills wait, and is awaited before the pull loop starts.
  const sweep = sweepStaleWorkDirs(config);
  sweep.catch(() => {}); // a failure surfaces at the await below; this only avoids an unhandled rejection meanwhile

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
    await new Promise(() => {}); // park; SIGTERM exits via the start-up signal handlers
  }

  configureTools(config.knightName, config.natsResultsPrefix);
  setSkillCount(await waitForSkills(config));

  await connectNats(config, `claude-knight-${config.knightName}`, metrics.setNatsConnected);
  startIntrospect({ ...introspectOptions(config), prefix: natsPrefix(config) });
  // Agent-card roster for find_knights / nats_request by name: a KV watch on <table>.* (none without KNIGHT_CARDS_BUCKET).
  // Only the sdk runtime runs the tools in this process; the cli runtime's stdio MCP child starts its own roster.
  startParentRoster(config.runtime, process.env, config.knightName);

  // Reports to the gauges before the count changes, so a throwing setter cannot leave it high.
  const activeTasks = createActiveCounter((n) => {
    setActiveTaskCount(n);
    metrics.activeTasks.labels().set(n);
  });
  // Register as a NATS micro service ($SRV.PING/INFO/STATS) for liveness, skills and load.
  // Discovery only: tasks stay on JetStream.
  let knightService: KnightService | null = null;
  metrics.setInfo(readPackageVersion(import.meta.url), config.claudeModel ?? "");
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
      getActive: () => activeTasks.get(),
      getCounts: () => countsFromMetrics(metrics.tasksTotal, config.knightName),
    }).catch((e) => {
      log.warn("NATS micro service registration failed", { error: String(e) });
      return null;
    });
  }
  let shuttingDown = false;
  let puller: Awaited<ReturnType<typeof subscribe>> | null = null;

  // Abort handles of running tasks, for the forced shutdown path.
  const inflight = new Set<TaskScope>();
  // Concurrency slots (0-based) in use, reported on task.started.
  const slots = new SlotPool();

  async function processTask(delivery: TaskDelivery, slot: number): Promise<void> {
    const parsed = delivery.task;
    // Skills may have changed (git-sync): re-read and re-register the service if so.
    // Not awaited: the slot must be counted synchronously so the next fetch sees it.
    void knightService?.refreshSkills();
    const started = Date.now();
    const timeoutMs = parsed.timeoutMs ?? config.taskTimeoutMs;
    // Everything taken after the slot is released in the finally below, even when a step throws part-way.
    let activity: TaskActivity | undefined;
    let scope: TaskScope | undefined;
    // Trace headers of the task span, captured while it is active: the result is published after it ends.
    let taskTrace: Record<string, string> | undefined;

    try {
      // Keep the message un-acked but alive while the task runs; the scope acks it on close.
      // Inside the try so the finally below always runs, even if opening the scope throws.
      const taskScope = startTaskScope({
        delivery,
        timeoutMs,
        onHeartbeat: () => activity?.heartbeat(),
        onOpen: () => activeTasks.increment(),
        onClose: () => activeTasks.decrement(),
      });
      scope = taskScope;
      inflight.add(taskScope);
      const queuedFor = metrics.observeQueuedFor(parsed.publishedAtMs, started);
      activity = new TaskActivity({
        knight: config.knightName,
        table: config.table,
        traceId: traceIdFromTraceparent(delivery.traceContext?.traceparent),
        prefix: natsPrefix(config),
        taskId: parsed.taskId,
        identity: podIdentity(process.env, hostname()),
        runId: parsed.runId,
        chainName: parsed.chainName,
        stepName: parsed.stepName,
        attempt: parsed.attempt,
        model: parsed.model ?? config.claudeModel,
        slot,
        concurrency: config.maxConcurrentTasks,
        queuedFor,
        workDir: basename(config.workDir),
        content: config.activityContent,
      });
      const act = activity;
      activity.started();

      // Plan reserve: refuse new work before spawning Claude Code at all.
      const reserve: { blocked: boolean; reason?: string } =
        config.authMode === "subscription"
          ? await checkReserveRefreshing(planReserveFromEnv(), () => probeUsage(config), {
              onCleared: () => log.info("Plan reserve cleared: usage is back under the reserve, accepting tasks"),
            })
          : { blocked: false };
      const outcome = reserve.blocked
        ? null
        : await withTaskSpan(
            { taskId: parsed.taskId, runId: parsed.runId, attempt: parsed.attempt, knight: config.knightName, table: config.table, model: parsed.model ?? config.claudeModel, runtime: "claude", parent: delivery.traceContext, chain: parsed.chainName, step: parsed.stepName, retryOf: parsed.retryOf, queuedMs: queuedFor },
            () => {
              act.setTraceId(activeTraceId());
              taskTrace = traceHeaders();
              return executeTask(withTaskLimitNote(promptWithRetryContext(parsed), timeoutMs, started), parsed.taskId, config, taskScope.signal, parsed.runId, { model: parsed.model, timeoutMs });
            },
            (o) => ({ success: o.success, cost: o.cost, model: o.model, tokens: o.tokens, error: o.error }),
          );

      if (!outcome) {
        await refuseForReserve({ parsed, scope: taskScope, reason: reserve.reason, config, started, activity });
        return;
      }

      const durationMs = Date.now() - started;
      activity?.finished({ success: outcome.success, error: outcome.error, errorClass: outcome.usageLimited ? "model_error" : undefined, cost: outcome.cost, tokens: outcome.tokens, turns: outcome.turns });

      // Metrics first: a result that cannot be published must not lose them or turn a success into an error. (#91)
      // Do not publish a made-up failure for a task that ran: the real result is lost.
      await publishTaskOutcome({
        taskId: parsed.taskId,
        record: () => recordTaskOutcome(outcome, durationMs),
        payload: () => buildResultPayload(outcome, { taskId: parsed.taskId, knight: config.knightName, durationMs, parsed }),
        traceHeaders: taskTrace,
        onPublishFailed: recordPublishFailed,
      });
    } catch (err) {
      const durationMs = Date.now() - started;
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error("Task failed", { taskId: parsed.taskId, error: errMsg });
      activity?.finished({ success: false, error: errMsg, errorClass: "internal", cost: 0 });
      await publishResult(
        parsed.taskId,
        buildResultPayload(failedOutcome(errMsg, config), { taskId: parsed.taskId, knight: config.knightName, durationMs, parsed }),
        { traceHeaders: taskTrace },
      ).catch((e) => log.error("Failed to publish error result", { error: String(e) }));

      metrics.tasksTotal.labels("error").inc();
      metrics.taskDuration.labels().observe(durationMs / 1000);
    } finally {
      if (scope) inflight.delete(scope);
      scope?.close(); // clears timers, drops the active count, then acks once
      activity?.close();
      knightService?.markTaskFinished();
      puller?.wake();
    }
  }

  const shutdown = createShutdown({
    setDraining: (d) => {
      shuttingDown = d; // freeSlots() -> 0: no new fetches
      setDraining(d);
    },
    stopService: () => knightService?.stop(),
    stopPulling: async () => void (await puller?.stop()),
    getActive: () => activeTasks.get(),
    maxWaitMs: config.drainTimeoutMs,
    // Grace period over with tasks still running: abort them so each publishes a failure
    // result (and acks) before exit, instead of being dead-lettered as lost later.
    abortInflight: () => {
      for (const s of inflight) s.abort(new ShutdownAbort());
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

  // No task may start while the stale-workspace sweep is still running, and none after a
  // termination requested during it (the start-up exit is already running).
  if (!(await mayPullAfterSweep(sweep, signals))) return;

  // Pull only when a slot is free; backlog stays in the stream (consumer lag), not in memory.
  puller = await subscribe(config, {
    // Guard: never fetch once a termination was requested, even one that came during start-up.
    freeSlots: () => (shuttingDown || signals.requested() !== null ? 0 : config.maxConcurrentTasks - activeTasks.get()),
    accept: (parsed) => !isSelfEcho(parsed, config.knightName),
    onTask: (delivery) => runInSlot(slots, delivery, processTask),
    onLost: async (parsed) => {
      metrics.recordLostTask();
      await publishResult(parsed.taskId, lostResultPayload(config, parsed));
    },
    // A payload that breaks the TaskPayload schema: answer with a failure naming the field.
    onInvalid: async (parsed) => {
      metrics.tasksTotal.labels("error").inc();
      await publishResult(parsed.taskId, invalidResultPayload(config, parsed));
    },
  });

  log.info("Claude-Knight ready");
}
