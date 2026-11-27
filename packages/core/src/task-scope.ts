import { log } from "./logger.js";
import { HEARTBEAT_MS, type TaskDelivery } from "./nats/index.js";

export interface TaskScopeOptions {
  delivery: Pick<TaskDelivery, "working" | "ack">;
  /** Aborts the signal (and sets `timedOut`) after this long. */
  timeoutMs: number;
  /** How often the in-progress ack is sent. Default HEARTBEAT_MS. */
  heartbeatMs?: number;
  /** Runs after each `delivery.working()`. A throw is logged and does not stop later beats. */
  onHeartbeat?: () => void;
  /** Runs once at start (e.g. bump the active count). A throw is logged; `onClose` is then skipped. */
  onOpen?: () => void;
  /** Runs once on close, only if `onOpen` ran (e.g. drop the active count). */
  onClose?: () => void;
}

export interface TaskScope {
  signal: AbortSignal;
  /** True when the signal was aborted by the timeout, not by `abort()`. */
  readonly timedOut: boolean;
  /** Aborts the signal, optionally with a reason (e.g. ShutdownAbort). */
  abort(reason?: unknown): void;
  /** Idempotent. Clears timer and interval, runs `onClose` (if opened), then acks exactly once. */
  close(): void;
}

/** The per-task resources every runtime holds: abort controller, timeout, heartbeat and exactly-once ack. */
export function startTaskScope(opts: TaskScopeOptions): TaskScope {
  const { delivery } = opts;
  const controller = new AbortController();
  let timedOut = false;
  let closed = false;
  let opened = false;

  const guard = (what: string, fn: (() => void) | undefined): void => {
    try {
      fn?.();
    } catch (e) {
      log.error(`Task scope ${what} failed`, { error: String(e) });
    }
  };

  // A throwing onOpen is logged, not propagated: the scope must still exist so the caller's
  // finally can close it (ack once). onClose then does not run, as the open never completed.
  try {
    opts.onOpen?.();
    opened = true;
  } catch (e) {
    log.error("Task scope onOpen failed", { error: String(e) });
  }

  const heartbeat = setInterval(() => {
    guard("heartbeat", () => delivery.working());
    guard("onHeartbeat", opts.onHeartbeat);
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    abort: (reason) => controller.abort(reason),
    close: () => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      clearInterval(heartbeat);
      if (opened) guard("onClose", opts.onClose);
      delivery.ack();
    },
  };
}
