import { connect as natsConnect, InvalidArgumentError, type NatsConnection } from "@nats-io/transport-node";
import {
  jetstream,
  jetstreamManager,
  type JetStreamClient,
  type JetStreamManager,
  AckPolicy,
  DeliverPolicy,
  JetStreamApiCodes,
  JetStreamApiError,
  type ConsumerConfig,
} from "@nats-io/jetstream";
import { log } from "../logger.js";
import { RESULT_PUBLISH_RETRY_MS } from "../config.js";

export { RESULT_PUBLISH_RETRY_MS };
import { RESULT_MAX_BYTES, assertTaskResult, capResultText, encodeResult, parseTask, type ParsedTask, type TaskResult } from "../contract/index.js";

const decoder = new TextDecoder();

/** What connectNats needs from the knight's config. */
export interface NatsConnectConfig {
  natsUrl: string;
  knightName: string;
  /** Total time publishResult keeps retrying a failing publish (RESULT_PUBLISH_RETRY_MS). Default 60 s. */
  resultPublishRetryMs?: number;
  /** Cap on the result text in bytes (RESULT_MAX_BYTES). Default 512 KB. */
  resultMaxBytes?: number;
}

/** What subscribe needs: the durable consumer is `<knightName>-consumer` on natsTasksStream. */
export interface NatsSubscribeConfig extends NatsConnectConfig {
  natsTasksStream: string;
  subscribeTopics: string[];
  natsResultsPrefix: string;
  /** Bounds how long a started task stays "active" in the tracker (plus the ack window). Default 30 min. */
  taskTimeoutMs?: number;
}

let nc: NatsConnection | null = null;
let js: JetStreamClient | null = null;
let connected = false;

// --- Accessors for custom tools ---
export function getConnection(): NatsConnection | null { return nc; }
export function getJetStream(): JetStreamClient | null { return js; }

export function getStatus(): { connected: boolean } {
  return { connected };
}

/**
 * Connect to NATS. `clientName` is the connection name shown in the server's monitoring
 * (e.g. `pi-knight-<name>`, `claude-knight-<name>-mcp`).
 */
export async function connectNats(
  config: NatsConnectConfig,
  clientName: string,
  /** Called with the initial state (true) and on every disconnect/reconnect. */
  onStatus?: (connected: boolean) => void,
): Promise<void> {
  _retryMs = config.resultPublishRetryMs ?? RESULT_PUBLISH_RETRY_MS;
  _resultMaxBytes = config.resultMaxBytes ?? RESULT_MAX_BYTES;
  log.info("Connecting to NATS", { url: config.natsUrl });

  nc = await natsConnect({
    servers: config.natsUrl,
    name: clientName,
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 2000,
  });

  connected = true;
  log.info("NATS connected");
  onStatus?.(true);

  // Monitor connection status
  void (async () => {
    if (!nc) return;
    for await (const status of nc.status()) {
      connected = applyStatus(connected, status, onStatus);
    }
  })().catch((e) => log.error("NATS status monitor loop failed", { error: String(e) }));

  js = jetstream(nc);
}

/** Heartbeat window: the server redelivers (here: dead-letters) a task whose ack is overdue by this much. */
export const ACK_WAIT_MS = 30_000;
/** How often a running task sends an in-progress ack. Must be well under ACK_WAIT_MS. */
export const HEARTBEAT_MS = 10_000;
/** Max time one pull request waits for messages before it is re-issued. */
const FETCH_EXPIRES_MS = 5_000;

/** The subset of a JetStream message the puller needs (satisfied by @nats-io/jetstream JsMsg). */
export interface PulledMsg {
  data: Uint8Array;
  subject: string;
  /** NATS message headers (nats.js MsgHdrs: `get` returns "" for a missing key). Optional. */
  headers?: { get(key: string): string | undefined };
  ack(): void;
  working(): void;
  term(reason?: string): void;
  // No nak(): with max_deliver 1 a nak'd task is never delivered again (MAX_DELIVERIES at once), i.e. lost.
}

export interface TraceContext {
  traceparent?: string;
  tracestate?: string;
}

function traceContextOf(msg: PulledMsg): TraceContext | undefined {
  // MsgHdrs.get returns "" for a missing key and does not throw, so no guard is needed.
  const traceparent = msg.headers?.get("traceparent") || undefined;
  const tracestate = msg.headers?.get("tracestate") || undefined;
  if (!traceparent && !tracestate) return undefined;
  return { ...(traceparent ? { traceparent } : {}), ...(tracestate ? { tracestate } : {}) };
}

/** A task taken from the stream. It stays un-acked until `ack()`; call `working()` to extend its ack window. */
export interface TaskDelivery {
  task: ParsedTask;
  /** W3C trace context the publisher put in the message headers; absent when it sent none. */
  traceContext?: TraceContext;
  /** In-progress ack: resets the server's ack_wait timer. */
  working(): void;
  /** Final ack — call once the task finished and its result was published. */
  ack(): void;
}

export interface PullLoopOptions {
  /** Pull up to `max` messages, waiting at most `expiresMs`. */
  fetch(max: number, expiresMs: number): Promise<AsyncIterable<PulledMsg>>;
  /** Free execution slots right now (maxConcurrentTasks - active). */
  freeSlots(): number;
  /** Called for each pulled task. Must count the slot as used synchronously. */
  onTask(delivery: TaskDelivery): void;
  /** Called for self-echo filtering etc. Return false to ack-and-drop the task. */
  accept?(task: ParsedTask): boolean;
  /**
   * Called for a payload that does not match the TaskPayload schema (`task.invalid` says
   * why). Publish a failure result naming the field; the message is acked once this
   * settles. Without it the message is terminated unanswered.
   */
  onInvalid?(task: ParsedTask): void | Promise<void>;
  fetchExpiresMs?: number;
  /** Delay after a fetch error before retrying. */
  retryDelayMs?: number;
}

export interface TaskPuller {
  /** Call when a slot frees so the loop re-checks capacity immediately. */
  wake(): void;
  /**
   * Stop pulling. Resolves once the outstanding pull request has ended (at most fetchExpiresMs);
   * anything it still delivers is handed to onTask like any other task (max_deliver 1 means it can
   * never be delivered again), so the drain that follows waits for it. Tasks already handed to
   * onTask are unaffected.
   */
  stop(): Promise<void>;
}

/**
 * Pull loop: only asks the server for as many messages as there are free slots, so
 * backlog stays in the stream (visible as consumer lag) rather than in process memory.
 */
export function startPullLoop(opts: PullLoopOptions): TaskPuller {
  let stopped = false;
  let wakeResolve: (() => void) | null = null;
  const sleepUnlessWoken = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); wakeResolve = null; resolve(); }
      wakeResolve = done;
    });

  const loop = (async () => {
    while (!stopped) {
      const free = opts.freeSlots();
      if (free <= 0) {
        await sleepUnlessWoken(1_000);
        continue;
      }
      try {
        const msgs = await opts.fetch(free, opts.fetchExpiresMs ?? FETCH_EXPIRES_MS);
        // Read the pull request to its end even after stop(): the server can still deliver to it,
        // and an un-run, un-acked message there is lost for good (max_deliver 1). It asked for at
        // most `free` messages, so taking them keeps within the slots that were free.
        for await (const msg of msgs) {
          if (stopped) log.info("Task delivered while stopping — running it before exit", { subject: msg.subject });
          // A synchronous throw while handling one message (an accept bug, a bad header object) must not
          // end the batch: the rest of it still has to be read, and this message is terminated, not retried.
          try {
            handleMsg(msg);
          } catch (err) {
            log.error("Task message handler threw — terminating the message", {
              subject: msg.subject,
              error: err instanceof Error ? err.message : String(err),
            });
            try { msg.term("handler error"); } catch { /* connection gone */ }
          }
        }
      } catch (err) {
        if (stopped) break;
        log.warn("Task fetch failed — retrying", { error: err instanceof Error ? err.message : String(err) });
        await sleepUnlessWoken(opts.retryDelayMs ?? 2_000);
      }
    }
  })();

  function handleMsg(msg: PulledMsg): void {
    const raw = decoder.decode(msg.data);
    const subject = msg.subject;
    const subjectTaskId = subject.split(".").pop() || "unknown";
    let parsed = parseTask(raw, subjectTaskId);
    // An empty/missing task text is answered like an invalid payload, so the dispatcher gets a failure
    // result instead of waiting for its timeout. No LLM call is made.
    if (!parsed.invalid && (!parsed.task || parsed.task.trim().length === 0)) {
      parsed = { ...parsed, invalid: "task: must not be empty" };
    }

    if (parsed.invalid) {
      log.warn("Invalid task payload", { taskId: parsed.taskId, subject, error: parsed.invalid });
      if (opts.accept && !opts.accept(parsed)) {
        msg.ack();
        return;
      }
      if (!opts.onInvalid) {
        msg.term("invalid task payload");
        return;
      }
      Promise.resolve()
        .then(() => opts.onInvalid!(parsed))
        .catch((err) => log.error("Failed to answer invalid task", { taskId: parsed.taskId, error: err instanceof Error ? err.message : String(err) }))
        .finally(() => msg.ack());
      return;
    }

    if (opts.accept && !opts.accept(parsed)) {
      msg.ack();
      return;
    }
    log.info("Task received", {
      taskId: parsed.taskId,
      subject,
      ...(parsed.attempt ? { attempt: parsed.attempt } : {}),
      ...(parsed.retryOf ? { retryOf: parsed.retryOf } : {}),
    });
    const traceContext = traceContextOf(msg);
    opts.onTask({ task: parsed, ...(traceContext ? { traceContext } : {}), working: () => msg.working(), ack: () => msg.ack() });
  }

  return {
    wake: () => wakeResolve?.(),
    async stop() {
      stopped = true;
      wakeResolve?.();
      await loop.catch(() => {});
    },
  };
}

export interface SubscribeOptions {
  freeSlots(): number;
  onTask(delivery: TaskDelivery): void;
  accept?(task: ParsedTask): boolean;
  /**
   * A task was delivered to a knight that never acked it (pod crash / hang) and
   * max_deliver=1 forbids re-running it. Publish a failure result so the dispatcher is not left waiting.
   */
  onLost(task: ParsedTask): void | Promise<void>;
  /** A payload that does not match the TaskPayload schema; publish a failure result naming the field. */
  onInvalid?(task: ParsedTask): void | Promise<void>;
  /**
   * Connection to use instead of the one from connectNats (tests: a second replica in one process).
   */
  connection?: NatsConnection;
  /**
   * Override the ack_wait heartbeat window (tests only). Only affects a consumer created by the
   * bindConsumer fallback; an operator-owned consumer keeps its own ack_wait.
   */
  ackWaitMs?: number;
}

/** Minimal JetStream manager surface bindConsumer needs (lets tests inject a fake). */
export interface ConsumerManager {
  consumers: {
    info(stream: string, durable: string): Promise<unknown>;
    add(stream: string, cfg: Partial<ConsumerConfig>): Promise<unknown>;
  };
}

export interface BindConsumerOptions {
  /** How long to wait for the operator to create the consumer before falling back. Default 2 min. */
  waitMs?: number;
  /** First retry delay; doubles each attempt up to maxDelayMs. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const BIND_WAIT_MS = 120_000;

/**
 * Bind to the durable consumer the operator owns; never modifies or deletes it.
 * If it is missing, retry with backoff for up to waitMs, then create it with `desired`
 * (fallback for knights running against an older operator).
 */
export async function bindConsumer(
  jsm: ConsumerManager,
  stream: string,
  desired: Partial<ConsumerConfig> & { durable_name: string },
  opts: BindConsumerOptions = {},
): Promise<"bound" | "created"> {
  const durable = desired.durable_name;
  const waitMs = opts.waitMs ?? BIND_WAIT_MS;
  const maxDelay = opts.maxDelayMs ?? 10_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + waitMs;
  let delay = opts.initialDelayMs ?? 1_000;

  for (let attempt = 1; ; attempt++) {
    try {
      await jsm.consumers.info(stream, durable);
      log.info("Bound to operator-owned consumer", { durable, stream, attempt });
      return "bound";
    } catch (err) {
      // Only a typed "consumer not found" (ConsumerNotFoundError, err_code 10014) means the operator hasn't created it yet;
      // timeouts, closed connections, permission errors etc. must fail start-up with the real cause.
      if (!(err instanceof JetStreamApiError && err.code === JetStreamApiCodes.ConsumerNotFound)) throw err;
      const remaining = deadline - now();
      log.info("Consumer not found yet — waiting for the operator", { durable, stream, attempt, remainingMs: Math.max(0, remaining) });
      if (remaining <= 0) break;
      await sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  log.warn("Consumer not created by the operator in time — creating it (older operator?)", { durable, stream, waitMs });
  await jsm.consumers.add(stream, desired);
  log.info("Consumer ready", { durable, stream });
  return "created";
}

/**
 * The settings of a knight's durable task consumer (`<knight>-consumer`), in NATS wire names. The operator
 * creates the same consumer; `contract/fixtures/consumer.knight-tasks.json` pins these values for it to vendor.
 */
export function taskConsumerConfig(
  knightName: string,
  filterSubjects: string[],
  ackWaitMs: number = ACK_WAIT_MS,
): Partial<ConsumerConfig> & { durable_name: string } {
  return {
    durable_name: `${knightName}-consumer`,
    filter_subjects: filterSubjects,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    // A task that crashed mid-run is NOT re-run silently; it is reported as a failure (see watchLostTasks).
    max_deliver: 1,
    // Heartbeat window, not the task timeout: running tasks send working() every HEARTBEAT_MS.
    ack_wait: ackWaitMs * 1_000_000, // nanoseconds
  };
}

/** Bind to the operator-owned durable pull consumer, start the pull loop and the lost-task watcher. */
export async function subscribe(config: NatsSubscribeConfig, opts: SubscribeOptions): Promise<TaskPuller> {
  const conn = opts.connection ?? nc;
  if (!conn) throw new Error("NATS not connected");
  if (!opts.connection) _config = config;
  const client = jetstream(conn);

  const jsm: JetStreamManager = await jetstreamManager(conn);

  const ackWaitMs = opts.ackWaitMs ?? ACK_WAIT_MS;
  const desired = taskConsumerConfig(config.knightName, config.subscribeTopics, ackWaitMs);
  const durableName = desired.durable_name;
  await bindConsumer(jsm, config.natsTasksStream, desired);

  const pullConsumer = await client.consumers.get(config.natsTasksStream, durableName);
  const tracker = new TaskTracker(undefined, undefined, undefined, (config.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS) + ackWaitMs);
  const stopWatch = watchLostTasks(conn, jsm, {
    stream: config.natsTasksStream,
    durable: durableName,
    resultsPrefix: config.natsResultsPrefix,
    tracker,
    onLost: opts.onLost,
  });
  const puller = startPullLoop({
    fetch: (max, expires) => pullConsumer.fetch({ max_messages: max, expires }),
    freeSlots: opts.freeSlots,
    onTask: (d) => {
      const id = d.task.taskId;
      tracker.started(id);
      let acked = false;
      opts.onTask({
        ...d,
        // A heartbeat proves the task is alive: the tracker's active bound runs from the last one.
        working: () => {
          tracker.touch(id);
          d.working();
        },
        ack: () => {
          if (acked) return; // a handler that failed early may ack on its error path too
          acked = true;
          tracker.finished(id);
          d.ack();
        },
      });
    },
    accept: opts.accept,
    onInvalid: opts.onInvalid,
  });
  return {
    wake: puller.wake,
    async stop() {
      await puller.stop();
      stopWatch();
    },
  };
}

/** Default per-task timeout (30 min) when the knight config sets none. */
const DEFAULT_TASK_TIMEOUT_MS = 1_800_000;
/** Default bound on an active id, measured from its last heartbeat: the default task timeout plus the ack window. */
const DEFAULT_ACTIVE_TTL_MS = DEFAULT_TASK_TIMEOUT_MS + ACK_WAIT_MS;

/**
 * Task ids this process is running or finished recently. A MAX_DELIVERIES advisory for one of
 * them is not a lost task: this process answers it (or already did) itself. Typical cause: the
 * event loop was blocked long enough to miss heartbeats, so the server gave up on the message
 * while the task was still running here.
 */
export class TaskTracker {
  private readonly active = new Map<string, { n: number; at: number }>();
  private readonly done = new Map<string, number>();
  constructor(
    private readonly ttlMs = 15 * 60_000,
    private readonly max = 1_000,
    private readonly now: () => number = Date.now,
    /** An active id older than this is dropped: a missed `finished` must not hide a lost task forever. */
    private readonly activeTtlMs = DEFAULT_ACTIVE_TTL_MS,
  ) {}

  started(taskId: string): void {
    const cur = this.active.get(taskId);
    // Re-use the count only while the entry is still live; an expired one starts over.
    const n = cur && cur.at >= this.now() - this.activeTtlMs ? cur.n : 0;
    this.active.set(taskId, { n: n + 1, at: this.now() });
  }

  finished(taskId: string): void {
    const cur = this.active.get(taskId);
    const n = cur?.n ?? 0;
    if (n <= 1) this.active.delete(taskId);
    else this.active.set(taskId, { n: n - 1, at: this.now() });
    this.done.delete(taskId); // re-insert: Map order = finish order, oldest first
    this.done.set(taskId, this.now());
    this.prune();
  }

  /** A heartbeat for a running task: restarts its active bound. No-op for unknown ids. */
  touch(taskId: string): void {
    const cur = this.active.get(taskId);
    if (cur) cur.at = this.now();
  }

  /** "active" (within activeTtlMs), "finished" (within ttlMs) or undefined when this process does not know the task. */
  state(taskId: string): "active" | "finished" | undefined {
    const cur = this.active.get(taskId);
    if (cur) {
      if (cur.at >= this.now() - this.activeTtlMs) return "active";
      this.active.delete(taskId); // expired: treated as unknown
    }
    this.prune();
    return this.done.has(taskId) ? "finished" : undefined;
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, at] of this.done) {
      if (at >= cutoff && this.done.size <= this.max) break;
      this.done.delete(id);
    }
  }
}

/** Budget for each JetStream API call findResult makes; an unreadable results stream must not delay the lost result. */
export const FIND_RESULT_TIMEOUT_MS = 2_000;

/** New `connected` value for a NATS status event: false on disconnect/close, true on reconnect, unchanged otherwise (an `error` status leaves the connection up). */
export function connectionStateFor(statusType: string, current: boolean): boolean {
  if (statusType === "disconnect" || statusType === "close") return false;
  if (statusType === "reconnect") return true;
  return current;
}

/** One NATS status event as the connection monitor sees it (a subset of nats.js Status). */
export interface NatsStatusEvent {
  type: string;
  error?: unknown;
}

/**
 * Applies one status event to the connection state and returns the new state. `onStatus` runs only
 * when the state changes; an `error` status is logged and leaves the state and the callback alone.
 */
export function applyStatus(connected: boolean, status: NatsStatusEvent, onStatus?: (connected: boolean) => void): boolean {
  if (status.type === "error") {
    // e.g. a permission violation on one subject: the connection is still up.
    log.warn("NATS error status", { error: String(status.error ?? "") });
    return connected;
  }
  const next = connectionStateFor(status.type, connected);
  if (next === connected) return connected;
  if (next) log.info("NATS reconnected");
  else log.warn("NATS disconnected", { type: status.type });
  onStatus?.(next);
  return next;
}

/**
 * The last result published for a task on `<resultsPrefix>.<taskId>`, if a stream stores it.
 * Undefined when there is none or it cannot be looked up (no results stream, no permission).
 */
export async function findResult(
  jsm: Pick<JetStreamManager, "streams">,
  resultsPrefix: string,
  taskId: string,
  timeoutMs = FIND_RESULT_TIMEOUT_MS,
): Promise<{ success: boolean } | undefined> {
  const subject = `${resultsPrefix}.${taskId}`;
  let timer: NodeJS.Timeout | undefined;
  const lookup = (async () => {
    const stream = await jsm.streams.find(subject);
    const m = await jsm.streams.getMessage(stream, { last_by_subj: subject });
    if (!m) return undefined;
    const r = m.json<{ success?: unknown }>();
    return { success: r.success === true };
  })();
  lookup.catch(() => {}); // a lookup that settles after the timeout must not be an unhandled rejection
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
  });
  try {
    return await Promise.race([lookup, timeout]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export interface WatchLostOptions {
  stream: string;
  durable: string;
  resultsPrefix: string;
  tracker: TaskTracker;
  onLost: (task: ParsedTask) => void | Promise<void>;
}

/**
 * Redelivery policy: max_deliver=1, so a task that was handed to a knight but never acked
 * (crash, OOM, hang past the heartbeat window) is not re-run. JetStream publishes a
 * MAX_DELIVERIES advisory for it; we load the original message by stream sequence and
 * report a failure result instead of losing it silently. The advisory subscription uses a
 * queue group so only one replica of the knight reports each lost task — but any replica,
 * so it can be about a task another replica (or this one) is running or has finished. Hence
 * no lost result for a task this process is running or recently finished, nor for one that
 * already has a successful result.
 */
export function watchLostTasks(conn: NatsConnection, jsm: JetStreamManager, o: WatchLostOptions): () => void {
  const sub = conn.subscribe(`$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${o.stream}.${o.durable}`, { queue: o.durable });
  void (async () => {
    for await (const m of sub) {
      try {
        const adv = m.json<{ stream_seq?: number }>();
        if (typeof adv.stream_seq !== "number") continue;
        const stored = await jsm.streams.getMessage(o.stream, { seq: adv.stream_seq });
        if (!stored) {
          log.warn("Lost task no longer in the stream — cannot report it", { seq: adv.stream_seq });
          continue;
        }
        const subjectTaskId = stored.subject.split(".").pop() || "unknown";
        const parsed = parseTask(stored.string(), subjectTaskId);
        const local = o.tracker.state(parsed.taskId);
        if (local) {
          log.warn("Ack deadline missed for a task this pod answers itself — not reporting it lost (heartbeats late? blocked event loop?)", {
            taskId: parsed.taskId, seq: adv.stream_seq, state: local,
          });
          continue;
        }
        const existing = await findResult(jsm, o.resultsPrefix, parsed.taskId);
        if (existing?.success) {
          log.warn("Ack deadline missed for a task that already has a successful result — not reporting it lost", { taskId: parsed.taskId, seq: adv.stream_seq });
          continue;
        }
        log.warn("Task delivered but never acked — reporting failure", { taskId: parsed.taskId, seq: adv.stream_seq });
        await o.onLost(parsed);
      } catch (err) {
        log.error("Failed to handle lost-task advisory", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  })().catch((e) => log.error("Lost-task advisory loop failed", { error: String(e) }));
  return () => sub.unsubscribe();
}

// Module-level config ref for publishResult (set during subscribe)
let _config: NatsSubscribeConfig | null = null;
let _retryMs = RESULT_PUBLISH_RETRY_MS;
let _resultMaxBytes = RESULT_MAX_BYTES;
/** Room kept for JSON escaping and the envelope when sizing the result text against max_payload. */
const PAYLOAD_MARGIN_BYTES = 1024;

/** While connected, "no responders" is retried this long (a stream electing a leader) before it counts as a missing stream. */
export const NO_RESPONDERS_RETRY_MS = 10_000;
const RETRY_INITIAL_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 5_000;

export interface PublishResultOptions {
  /** Total retry budget in ms (0 = a single attempt). Default: RESULT_PUBLISH_RETRY_MS / the connectNats config. */
  retryMs?: number;
  /** Cap on the result text in bytes. Default: the connectNats config / RESULT_MAX_BYTES. */
  resultMaxBytes?: number;
  /** Server max_payload in bytes (tests). Default: the live connection's. */
  maxPayload?: number;
  /** JetStream client to use instead of the one from connectNats (tests). */
  js?: Pick<JetStreamClient, "publish">;
  /** Budget for "no responders" while connected (leader election); a missing stream fails after this. Default 10 s. */
  noRespondersRetryMs?: number;
  /** Connection state probe (tests). Default: the live connection. */
  isConnected?: () => boolean;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * True for an error no retry can fix: a payload over the server's max_payload, a bad argument,
 * or a 4xx JetStream API answer. "Nobody answered" is not here: see isNoRespondersError.
 */
export function isNonRetryablePublishError(err: unknown): boolean {
  if (err instanceof InvalidArgumentError || err instanceof TypeError) return true;
  if (err instanceof JetStreamApiError) return err.status >= 400 && err.status < 500;
  return false;
}

/** js.publish reports "nobody answered" as JetStreamNotEnabled (class not exported by the package). */
export function isNoRespondersError(err: unknown): boolean {
  return err instanceof Error && err.message === "jetstream is not enabled";
}

/**
 * Cap the result text to the smaller of RESULT_MAX_BYTES and what the server's max_payload
 * leaves after the rest of the result. Runs after prs/verdict were extracted from the full text.
 */
function capForPayload(taskId: string, result: TaskResult, opts: PublishResultOptions): TaskResult {
  let budget = opts.resultMaxBytes ?? _resultMaxBytes;
  const maxPayload = opts.maxPayload ?? nc?.info?.max_payload;
  if (maxPayload && maxPayload > 0) {
    const overhead = Buffer.byteLength(encodeResult({ ...result, result: "", result_truncated: true }));
    budget = Math.min(budget, maxPayload - overhead - PAYLOAD_MARGIN_BYTES);
  }
  budget = Math.max(budget, 256);
  let capped = capResultText(result, budget);
  // JSON escaping grows the text (newline/quote 2x, control chars 6x), so measure the encoded
  // payload and cut again until it fits. Each step keeps the share of maxPayload that the text
  // can use: the escaped text must fit in what the other fields leave of maxPayload.
  if (maxPayload && maxPayload > 0) {
    while (budget > 256 && Buffer.byteLength(encodeResult(capped)) > maxPayload) {
      const keptBytes = Buffer.byteLength(capped.result);
      const encodedText = Buffer.byteLength(JSON.stringify(capped.result));
      const rest = Buffer.byteLength(encodeResult(capped)) - encodedText;
      const room = maxPayload - rest;
      const next = Math.floor((keptBytes * room) / encodedText);
      // Always shrink, so the loop ends even when the estimate does not move.
      budget = Math.max(256, Math.min(budget - 1, next));
      capped = capResultText(result, budget);
    }
  }
  if (capped !== result) {
    log.warn("Result text truncated to fit the payload limit", {
      taskId,
      originalBytes: Buffer.byteLength(result.result),
      keptBytes: Buffer.byteLength(capped.result),
    });
  }
  return capped;
}

/**
 * Publish a task result to `<resultsPrefix>.<taskId>`. A failing publish (NATS reconnecting,
 * leader change) is retried with exponential backoff (0.5 s doubling to 5 s) for up to the
 * retry budget; errors that cannot succeed are thrown at once.
 */
export async function publishResult(
  taskId: string,
  result: TaskResult,
  opts: PublishResultOptions = {},
): Promise<void> {
  const client = opts.js ?? js;
  if (!client) throw new Error("NATS not connected — cannot publish result");

  // Contract check in tests only (node --test sets NODE_TEST_CONTEXT); never at runtime.
  if (process.env.NODE_TEST_CONTEXT) assertTaskResult(result);

  const prefix = _config?.natsResultsPrefix ?? "fleet-a.results";
  const subject = `${prefix}.${taskId}`;
  const payload = encodeResult(capForPayload(taskId, result, opts));
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + (opts.retryMs ?? _retryMs);
  const maxDelay = opts.maxDelayMs ?? RETRY_MAX_DELAY_MS;
  let delay = opts.initialDelayMs ?? RETRY_INITIAL_DELAY_MS;
  const noRespondersMs = opts.noRespondersRetryMs ?? NO_RESPONDERS_RETRY_MS;
  let noRespondersSince: number | undefined;
  // Same msgID on every attempt: a timed-out publish may have been stored, and JetStream
  // drops the duplicate (default duplicate window 2 min > the retry budget).
  const msgID = `result-${taskId}`;

  for (let attempt = 1; ; attempt++) {
    try {
      await client.publish(subject, payload, { msgID });
      log.info("Result published", { taskId, subject, ...(attempt > 1 ? { attempt } : {}) });
      return;
    } catch (err) {
      const remaining = deadline - now();
      if (isNonRetryablePublishError(err) || remaining <= 0) throw err;
      if (isNoRespondersError(err) && (opts.isConnected ?? (() => connected))()) {
        // Connected but nobody answered: a leader election, or no stream for the subject. Fail fast on the latter.
        noRespondersSince ??= now();
        if (now() - noRespondersSince >= noRespondersMs) throw err;
      } else {
        noRespondersSince = undefined;
      }
      const wait = Math.min(delay, remaining);
      log.warn("Result publish failed — retrying", {
        taskId, subject, attempt, retryInMs: wait, error: err instanceof Error ? err.message : String(err),
      });
      await sleep(wait);
      delay = Math.min(delay * 2, maxDelay);
    }
  }
}

export async function drain(): Promise<void> {
  if (nc) {
    await nc.drain();
    connected = false;
    log.info("NATS drained");
  }
}
