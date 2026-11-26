/**
 * Knight-to-knight messaging shared by the pi-knight and claude-knight tools:
 * `requestKnight` (nats_request) and `publishOutOfBand` (nats_publish).
 * The runtimes only wrap these in their own tool schemas.
 */
import { headers as natsHeaders, type NatsConnection } from "@nats-io/transport-node";
import type { JetStreamClient } from "@nats-io/jetstream";
import { getConnection, getJetStream } from "./nats/index.js";
import { resolveRequestTarget } from "./roster.js";
import { traceHeaders } from "./trace-context.js";
import { log } from "./logger.js";

export interface KnightToolResult {
  ok: boolean;
  text: string;
}

/** Connection handles; defaults to the process-wide NATS connection. Injectable for tests. */
export interface NatsHandles {
  nc: NatsConnection | null;
  js: JetStreamClient | null;
}

export interface RequestKnightOptions {
  /** This knight's name (the `from` / `dispatched_by` of the task). */
  knightName: string;
  /** Table prefix, e.g. "rt-dev". */
  prefix: string;
  knight: string;
  /** Looked up from the target's agent card when omitted. */
  domain?: string;
  task: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
  conn?: NatsHandles;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

const fail = (text: string): KnightToolResult => ({ ok: false, text });

/** Format a reply from the requested knight. */
export function formatRequestResponse(knight: string, raw: string): KnightToolResult {
  try {
    const result = JSON.parse(raw);
    const success = result.success ?? true;
    const body = result.result ?? result.output ?? raw;
    const cost = typeof result.cost === "number" ? result.cost : 0;
    const duration = typeof result.duration_ms === "number" ? result.duration_ms : 0;
    if (success) {
      return { ok: true, text: `Response from ${knight} (${Math.round(duration / 1000)}s, $${cost.toFixed(4)}):\n\n${body}` };
    }
    return fail(`${knight} reported failure: ${result.error ?? body}`);
  } catch {
    return { ok: true, text: `Raw response from ${knight}: ${raw}` };
  }
}

/**
 * Send a task to another knight in the table and wait for its single reply.
 * Subscribes to the result subject before publishing, carries the caller's trace
 * context in the message headers, and stops waiting when `signal` aborts.
 */
export async function requestKnight(opts: RequestKnightOptions): Promise<KnightToolResult> {
  if (!opts.task || opts.task.trim().length === 0) {
    log.warn("nats_request: empty task rejected", { knight: opts.knight, domain: opts.domain });
    return fail("Error: Cannot send empty task. Provide a non-empty task description.");
  }
  const target = await resolveRequestTarget(opts.knight, opts.domain);
  if ("error" in target) return fail(`Error: ${target.error}`);
  const { knight, domain } = target;

  const { nc, js } = opts.conn ?? { nc: getConnection(), js: getJetStream() };
  if (!js || !nc) return fail("Error: NATS not connected");
  const { prefix, signal } = opts;
  const cancelledText = `Request to ${knight} was cancelled`;
  if (signal?.aborted) return fail(cancelledText);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const taskId = `${knight}-xreq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const taskSubject = `${prefix}.tasks.${domain}.${taskId}`;
  const resultSubject = `${prefix}.results.${taskId}`;
  const timeoutText = `Timeout: ${knight} did not respond within ${Math.round(timeoutMs / 1000)}s`;

  log.info("nats_request: dispatching", { knight, domain, taskId, timeoutMs, prefix });
  opts.onProgress?.(`Dispatching to ${knight} (${domain})…`);

  let sub: ReturnType<NatsConnection["subscribe"]> | undefined;
  let published = false;
  const onAbort = () => sub?.unsubscribe();
  try {
    // Subscribe before publishing so a fast reply can't be missed.
    sub = nc.subscribe(resultSubject, { max: 1, timeout: timeoutMs });
    signal?.addEventListener("abort", onAbort, { once: true });

    const hdrs = natsHeaders();
    for (const [k, v] of Object.entries(traceHeaders())) hdrs.set(k, v);
    await js.publish(
      taskSubject,
      JSON.stringify({
        task: opts.task,
        task_id: taskId,
        domain,
        from: opts.knightName.toLowerCase(),
        dispatched_by: opts.knightName,
        timestamp: new Date().toISOString(),
        metadata: { timeout_ms: timeoutMs, table_prefix: prefix },
      }),
      { headers: hdrs },
    );
    published = true;
    log.info("nats_request: task published", { taskId, subject: taskSubject });
    opts.onProgress?.(`Task sent to ${knight}; awaiting response (timeout ${Math.round(timeoutMs / 1000)}s)…`);
    if (signal?.aborted) sub.unsubscribe();

    for await (const msg of sub) {
      const response = formatRequestResponse(knight, msg.string());
      log.info("nats_request: response received", { taskId, ok: response.ok });
      return response;
    }
    return signal?.aborted ? fail(cancelledText) : fail(timeoutText);
  } catch (err) {
    if (signal?.aborted) return fail(cancelledText);
    const msg = err instanceof Error ? err.message : String(err);
    // A failed publish never reached the knight: report it as such, not as a missing reply.
    if (!published) {
      log.error("nats_request publish failed", { taskId, error: msg });
      return fail(`Error publishing task to ${knight}: ${msg}`);
    }
    // the subscription iterator throws a TimeoutError ("timeout") when no reply arrives in time
    if (/timeout/i.test(msg)) return fail(timeoutText);
    log.error("nats_request failed", { taskId, error: msg });
    return fail(`Error requesting from ${knight}: ${msg}`);
  } finally {
    sub?.unsubscribe();
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Fire-and-forget publish to any subject (alerts, reports, broadcasts). */
export async function publishOutOfBand(subject: string, message: string, conn?: Pick<NatsHandles, "js">): Promise<KnightToolResult> {
  const js = conn ? conn.js : getJetStream();
  if (!js) return fail("Error: NATS not connected");
  if (!message || message.trim().length === 0) {
    log.warn("nats_publish: empty message rejected", { subject });
    return fail("Error: Cannot publish empty message. Provide a non-empty message payload.");
  }
  try {
    await js.publish(subject, message);
    const bytes = Buffer.byteLength(message);
    log.info("nats_publish tool", { subject, size: bytes });
    return { ok: true, text: `Published to ${subject} (${bytes} bytes)` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("nats_publish failed", { subject, error: msg });
    return fail(`Error publishing to ${subject}: ${msg}`);
  }
}
