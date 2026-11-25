import { connect as natsConnect, type NatsConnection } from "@nats-io/transport-node";
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
import { assertTaskResult, encodeResult, parseTask, type ParsedTask, type TaskResult } from "../contract/index.js";

const decoder = new TextDecoder();

/** What connectNats needs from the knight's config. */
export interface NatsConnectConfig {
  natsUrl: string;
  knightName: string;
}

/** What subscribe needs: the durable consumer is `<knightName>-consumer` on natsTasksStream. */
export interface NatsSubscribeConfig extends NatsConnectConfig {
  natsTasksStream: string;
  subscribeTopics: string[];
  natsResultsPrefix: string;
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
export async function connectNats(config: NatsConnectConfig, clientName: string): Promise<void> {
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

  // Monitor connection status
  (async () => {
    if (!nc) return;
    for await (const status of nc.status()) {
      if (status.type === "disconnect" || status.type === "error") {
        connected = false;
        log.warn("NATS disconnected", { type: status.type });
      } else if (status.type === "reconnect") {
        connected = true;
        log.info("NATS reconnected");
      }
    }
  })();

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
  ack(): void;
  working(): void;
  term(reason?: string): void;
  /** Hand the message back for redelivery without running it. */
  nak(): void;
}

/** A task taken from the stream. It stays un-acked until `ack()`; call `working()` to extend its ack window. */
export interface TaskDelivery {
  task: ParsedTask;
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
  /** Stop pulling. Messages already handed to onTask are unaffected. */
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
        for await (const msg of msgs) {
          // A fetch already in flight when we began draining must not start new work.
          if (stopped) { msg.nak(); continue; }
          handleMsg(msg);
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
    const parsed = parseTask(raw, subjectTaskId);

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

    // Reject empty/missing task text — don't waste an LLM call on nothing
    if (!parsed.task || parsed.task.trim().length === 0) {
      log.warn("Empty task payload — skipping", { taskId: parsed.taskId, subject, rawLength: raw.length });
      msg.term("empty task payload");
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
    opts.onTask({ task: parsed, working: () => msg.working(), ack: () => msg.ack() });
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

/** Bind to the operator-owned durable pull consumer, start the pull loop and the lost-task watcher. */
export async function subscribe(config: NatsSubscribeConfig, opts: SubscribeOptions): Promise<TaskPuller> {
  if (!nc || !js) throw new Error("NATS not connected");
  _config = config;

  const jsm: JetStreamManager = await jetstreamManager(nc);

  const durableName = `${config.knightName}-consumer`;
  const ackWaitMs = opts.ackWaitMs ?? ACK_WAIT_MS;
  await bindConsumer(jsm, config.natsTasksStream, {
    durable_name: durableName,
    filter_subjects: config.subscribeTopics,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.All,
    // A task that crashed mid-run is NOT re-run silently; it is reported as a failure (see watchLostTasks).
    max_deliver: 1,
    // Heartbeat window, not the task timeout: running tasks send working() every HEARTBEAT_MS.
    ack_wait: ackWaitMs * 1_000_000, // nanoseconds
  });

  const pullConsumer = await js.consumers.get(config.natsTasksStream, durableName);
  const stopWatch = watchLostTasks(jsm, config.natsTasksStream, durableName, opts.onLost);
  const puller = startPullLoop({
    fetch: (max, expires) => pullConsumer.fetch({ max_messages: max, expires }),
    freeSlots: opts.freeSlots,
    onTask: opts.onTask,
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

/**
 * Redelivery policy: max_deliver=1, so a task that was handed to a knight but never acked
 * (crash, OOM, hang past the heartbeat window) is not re-run. JetStream publishes a
 * MAX_DELIVERIES advisory for it; we load the original message by stream sequence and
 * report a failure result instead of losing it silently. The advisory subscription uses a
 * queue group so only one replica of the knight reports each lost task.
 */
function watchLostTasks(
  jsm: JetStreamManager,
  stream: string,
  durable: string,
  onLost: (task: ParsedTask) => void | Promise<void>,
): () => void {
  const sub = nc!.subscribe(`$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${stream}.${durable}`, { queue: durable });
  (async () => {
    for await (const m of sub) {
      try {
        const adv = m.json<{ stream_seq?: number }>();
        if (typeof adv.stream_seq !== "number") continue;
        const stored = await jsm.streams.getMessage(stream, { seq: adv.stream_seq });
        if (!stored) {
          log.warn("Lost task no longer in the stream — cannot report it", { seq: adv.stream_seq });
          continue;
        }
        const subjectTaskId = stored.subject.split(".").pop() || "unknown";
        const parsed = parseTask(stored.string(), subjectTaskId);
        log.warn("Task delivered but never acked — reporting failure", { taskId: parsed.taskId, seq: adv.stream_seq });
        await onLost(parsed);
      } catch (err) {
        log.error("Failed to handle lost-task advisory", { error: err instanceof Error ? err.message : String(err) });
      }
    }
  })();
  return () => sub.unsubscribe();
}

// Module-level config ref for publishResult (set during subscribe)
let _config: NatsSubscribeConfig | null = null;

export async function publishResult(
  taskId: string,
  result: TaskResult,
): Promise<void> {
  if (!js) throw new Error("NATS not connected — cannot publish result");

  // Contract check in tests only (node --test sets NODE_TEST_CONTEXT); never at runtime.
  if (process.env.NODE_TEST_CONTEXT) assertTaskResult(result);

  const prefix = _config?.natsResultsPrefix ?? "fleet-a.results";
  const subject = `${prefix}.${taskId}`;
  await js.publish(subject, encodeResult(result));
  log.info("Result published", { taskId, subject });
}

export async function drain(): Promise<void> {
  if (nc) {
    await nc.drain();
    connected = false;
    log.info("NATS drained");
  }
}
