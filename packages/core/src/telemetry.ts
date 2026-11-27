import { SpanStatusCode, ROOT_CONTEXT, context, propagation, trace, type Context, type Span, type SpanAttributes } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { boundText } from "./activity.js";
import { log } from "./logger.js";

const TRACER_NAME = "@roundtable/knight-core";

export interface TelemetryOptions {
  /** Runtime name, the default `service.name` (`pi-knight`, `claude-knight`). */
  service: string;
  knight: string;
  /** Table name; `none` when unset. */
  table?: string;
  env?: NodeJS.ProcessEnv;
  /** Replace the OTLP exporter (tests). */
  spanProcessors?: SpanProcessor[];
}

export interface Telemetry {
  enabled: boolean;
  /** Flush pending spans and stop the SDK. A no-op when disabled. */
  shutdown(): Promise<void>;
}

/**
 * Tracing is on only when an exporter is configured and the SDK is not disabled. `OTEL_TRACES_EXPORTER=none`
 * (the OpenTelemetry value for no exporter) counts as not configured; a general or traces endpoint still turns it on.
 */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["OTEL_SDK_DISABLED"]?.trim().toLowerCase() === "true") return false;
  const exporter = env["OTEL_TRACES_EXPORTER"]?.trim().toLowerCase();
  return !!(
    env["OTEL_EXPORTER_OTLP_ENDPOINT"]?.trim() ||
    env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"]?.trim() ||
    (exporter && exporter !== "none")
  );
}

function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const key = pair.slice(0, i).trim();
    if (!key) continue;
    const raw = pair.slice(i + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      // A stray percent sign (`50%`) is not valid escaping; keep the value as written rather than fail startup.
      log.warn("Invalid OTEL_RESOURCE_ATTRIBUTES entry, using it undecoded", { key });
      out[key] = raw;
    }
  }
  return out;
}

/** Resource attributes we add; anything OTEL_RESOURCE_ATTRIBUTES / OTEL_SERVICE_NAME already sets wins. */
export function resourceDefaults(opts: TelemetryOptions): Record<string, string> {
  const env = opts.env ?? process.env;
  const set = parseResourceAttributes(env["OTEL_RESOURCE_ATTRIBUTES"]);
  const defaults: Record<string, string> = {
    "roundtable.knight": opts.knight,
    "roundtable.knight.runtime": opts.service.replace(/-knight$/, ""),
    "roundtable.table": opts.table || env["ROUNDTABLE_TABLE"] || "none",
  };
  if (!env["OTEL_SERVICE_NAME"]) defaults["service.name"] = opts.service;
  for (const k of Object.keys(defaults)) if (k in set) delete defaults[k];
  return defaults;
}

const DISABLED: Telemetry = { enabled: false, shutdown: async () => {} };

/**
 * Start the OpenTelemetry Node SDK when OTEL_* env asks for it. Otherwise nothing is
 * registered and no startup log is written.
 */
export async function startTelemetry(opts: TelemetryOptions): Promise<Telemetry> {
  const env = opts.env ?? process.env;
  if (!telemetryEnabled(env)) return DISABLED;
  let sdk: { start(): void; shutdown(): Promise<void> };
  try {
    // Loaded on demand so a knight with telemetry off never pays for the SDK.
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    sdk = new NodeSDK({
      // Traces only: no OTLP metrics (prom-client stays) or logs exporters.
      metricReaders: [],
      logRecordProcessors: [],
      resource: resourceFromAttributes(resourceDefaults(opts)),
      ...(opts.spanProcessors ? { spanProcessors: opts.spanProcessors } : {}),
    });
    sdk.start();
  } catch (error) {
    // Tracing is never fatal: the knight runs on without it.
    log.warn("OpenTelemetry could not start", { error: String(error) });
    return DISABLED;
  }
  log.info("OpenTelemetry tracing started", { service: env["OTEL_SERVICE_NAME"] || opts.service });
  return {
    enabled: true,
    shutdown: () => sdk.shutdown().catch((e) => log.warn("OpenTelemetry shutdown failed", { error: String(e) })),
  };
}

export interface TaskSpanAttributes {
  taskId: string;
  runId?: string;
  knight: string;
  table?: string;
  attempt?: number;
  /** Requested model. */
  model?: string;
  /** W3C trace context from the task message headers; the span becomes its child when valid. */
  parent?: { traceparent?: string; tracestate?: string };
  /** Runtime name (`pi`, `claude`). */
  runtime?: string;
  /** Chain name; absent for ask-a-knight tasks. */
  chain?: string;
  /** Chain step name; absent for ask-a-knight tasks. */
  step?: string;
}

export interface TaskSpanOutcome {
  success: boolean;
  /** Cost in USD. */
  cost?: number;
  /** Resolved model. */
  model?: string;
  /** Token usage; `input` excludes cached input (task contract). */
  tokens?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  error?: string;
}

/** Span outcome extraction must not fail a task that already succeeded: a throw is logged and dropped. */
function safeOutcome<T>(outcome: (result: T) => TaskSpanOutcome, result: T): TaskSpanOutcome | undefined {
  try {
    return outcome(result);
  } catch (error) {
    log.warn("Task span outcome could not be recorded", { error: String(error) });
    return undefined;
  }
}

/**
 * Run `fn` inside a new `invoke_agent <knight>` span. It is a child of `attrs.parent` (the NATS
 * `traceparent`/`tracestate` headers) when that is a valid trace context, otherwise a root span.
 * With no SDK registered the tracer is a no-op and this just calls `fn`.
 */
export function withTaskSpan<T>(
  attrs: TaskSpanAttributes,
  fn: () => Promise<T>,
  outcome?: (result: T) => TaskSpanOutcome,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const attributes: Record<string, string | number> = {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.agent.name": attrs.knight,
    "roundtable.task.id": attrs.taskId,
    "roundtable.knight": attrs.knight,
    "roundtable.table": attrs.table || "none",
  };
  if (attrs.runId) attributes["roundtable.run.id"] = attrs.runId;
  if (attrs.attempt) attributes["roundtable.attempt"] = attrs.attempt;
  if (attrs.model) attributes["gen_ai.request.model"] = attrs.model;
  if (attrs.runtime) attributes["roundtable.knight.runtime"] = attrs.runtime;
  if (attrs.chain) attributes["roundtable.chain"] = attrs.chain;
  if (attrs.step) attributes["roundtable.chain.step"] = attrs.step;
  let parentCtx = context.active();
  let root = true;
  if (attrs.parent?.traceparent) {
    const carrier: Record<string, string> = { traceparent: attrs.parent.traceparent };
    if (attrs.parent.tracestate) carrier["tracestate"] = attrs.parent.tracestate;
    const extracted = propagation.extract(ROOT_CONTEXT, carrier);
    const sc = trace.getSpanContext(extracted);
    if (sc && trace.isSpanContextValid(sc)) {
      parentCtx = extracted;
      root = false;
    }
  }
  return tracer.startActiveSpan(`invoke_agent ${attrs.knight}`, { ...(root ? { root: true } : {}), attributes }, parentCtx, async (span: Span) => {
    try {
      const result = await fn();
      const o = outcome && safeOutcome(outcome, result);
      if (o) {
        if (o.cost !== undefined) span.setAttribute("roundtable.cost.usd", o.cost);
        if (o.model) span.setAttribute("gen_ai.response.model", o.model);
        if (o.tokens) {
          const cacheRead = o.tokens.cacheRead ?? 0;
          const cacheWrite = o.tokens.cacheWrite ?? 0;
          // semconv input_tokens includes cached reads and writes; the contract's `input` does not.
          span.setAttribute("gen_ai.usage.input_tokens", o.tokens.input + cacheRead + cacheWrite);
          span.setAttribute("gen_ai.usage.output_tokens", o.tokens.output);
          if (o.tokens.cacheRead !== undefined) span.setAttribute("gen_ai.usage.cache_read.input_tokens", cacheRead);
          if (o.tokens.cacheWrite !== undefined) span.setAttribute("gen_ai.usage.cache_creation.input_tokens", cacheWrite);
        }
        if (!o.success) span.setStatus({ code: SpanStatusCode.ERROR, message: o.error });
      }
      return result;
    } catch (err) {
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}


/**
 * Start a child span of `parent` (default: the active context, so the task span inside
 * `withTaskSpan`) with an explicit start time (ms epoch). The caller must `endSpan` it.
 * A no-op span when no SDK is registered.
 */
export function startChildSpan(
  name: string,
  attributes: SpanAttributes = {},
  opts: { startTime?: number; parent?: Context } = {},
): Span {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startSpan(
    name,
    { attributes, ...(opts.startTime !== undefined ? { startTime: opts.startTime } : {}) },
    opts.parent ?? context.active(),
  );
}

/** Set final attributes, mark an error status when `error` is set, and end the span. */
export function endSpan(
  span: Span,
  opts: { attributes?: SpanAttributes; error?: string | boolean; endTime?: number } = {},
): void {
  if (opts.attributes) span.setAttributes(opts.attributes);
  if (opts.error) {
    span.setStatus({ code: SpanStatusCode.ERROR, ...(typeof opts.error === "string" ? { message: opts.error } : {}) });
  }
  span.end(opts.endTime);
}

/** The current trace context, to parent spans started later from an event callback. */
export function activeTraceContext(): Context {
  return context.active();
}

const DEFAULT_CONTENT_MAX_BYTES = 16 * 1024;

/** Content capture is on by default; `ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT=false` (or `0`) turns it off. */
export function captureContent(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env["ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT"]?.trim().toLowerCase();
  return !(v === "false" || v === "0");
}

/** Per-attribute cap in bytes (`ROUNDTABLE_TELEMETRY_CONTENT_MAX_BYTES`, default 16 KiB). */
export function contentMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env["ROUNDTABLE_TELEMETRY_CONTENT_MAX_BYTES"]);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_CONTENT_MAX_BYTES;
}

/**
 * Set a content attribute (prompt, response, tool arguments or result) on `span`: redacted with
 * `redactSecrets`, cut to the byte cap with `roundtable.content.truncated=true` when cut. Does
 * nothing when content capture is off or `value` is empty. Returns whether it was set.
 */
export function setContentAttribute(span: Span, key: string, value: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!captureContent(env) || !value) return false;
  const max = contentMaxBytes(env);
  let { text, truncated } = boundText(value, max);
  if (Buffer.byteLength(text) > max) {
    // Cut on a byte boundary without leaving a split multi-byte character behind.
    const buf = Buffer.from(text);
    let end = max;
    while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // back off to a character start
    text = buf.subarray(0, end).toString("utf8");
    truncated = true;
  }
  span.setAttribute(key, text);
  if (truncated) span.setAttribute("roundtable.content.truncated", true);
  return true;
}
