import { SpanStatusCode, context, trace, type Span } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
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

/** Tracing is on only when an exporter is configured and the SDK is not disabled. */
export function telemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env["OTEL_SDK_DISABLED"]?.trim().toLowerCase() === "true") return false;
  return !!(env["OTEL_EXPORTER_OTLP_ENDPOINT"]?.trim() || env["OTEL_TRACES_EXPORTER"]?.trim());
}

function parseResourceAttributes(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i <= 0) continue;
    const key = pair.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

/** Resource attributes we add; anything OTEL_RESOURCE_ATTRIBUTES / OTEL_SERVICE_NAME already sets wins. */
export function resourceDefaults(opts: TelemetryOptions): Record<string, string> {
  const env = opts.env ?? process.env;
  const set = parseResourceAttributes(env["OTEL_RESOURCE_ATTRIBUTES"]);
  const defaults: Record<string, string> = {
    "roundtable.knight": opts.knight,
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
export function startTelemetry(opts: TelemetryOptions): Telemetry {
  const env = opts.env ?? process.env;
  if (!telemetryEnabled(env)) return DISABLED;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes(resourceDefaults(opts)),
    ...(opts.spanProcessors ? { spanProcessors: opts.spanProcessors } : {}),
  });
  sdk.start();
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
  model?: string;
}

export interface TaskSpanOutcome {
  success: boolean;
  cost?: number;
  model?: string;
  error?: string;
}

/**
 * Run `fn` inside a new root `knight.task` span (no parent until NATS trace propagation lands).
 * With no SDK registered the tracer is a no-op and this just calls `fn`.
 */
export function withTaskSpan<T>(
  attrs: TaskSpanAttributes,
  fn: () => Promise<T>,
  outcome?: (result: T) => TaskSpanOutcome,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const attributes: Record<string, string> = {
    "roundtable.task.id": attrs.taskId,
    "roundtable.knight": attrs.knight,
    "roundtable.table": attrs.table || "none",
  };
  if (attrs.runId) attributes["roundtable.run.id"] = attrs.runId;
  if (attrs.model) attributes["roundtable.model"] = attrs.model;
  return tracer.startActiveSpan("knight.task", { root: true, attributes }, async (span: Span) => {
    try {
      const result = await fn();
      if (outcome) {
        const o = outcome(result);
        span.setAttribute("roundtable.task.success", o.success);
        if (o.cost !== undefined) span.setAttribute("roundtable.task.cost", o.cost);
        if (o.model) span.setAttribute("roundtable.model", o.model);
        if (!o.success) span.setStatus({ code: SpanStatusCode.ERROR, message: o.error });
      }
      return result;
    } catch (err) {
      span.setAttribute("roundtable.task.success", false);
      span.recordException(err instanceof Error ? err : String(err));
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Trace and span ids of the active recording span, for log lines. */
export function activeTraceIds(): { trace_id: string; span_id: string } | undefined {
  const span = trace.getSpan(context.active());
  if (!span?.isRecording()) return undefined;
  const { traceId, spanId } = span.spanContext();
  return { trace_id: traceId, span_id: spanId };
}

/** `TRACEPARENT` for a child process, from the active span; empty when there is none. */
export function traceparentEnv(): Record<string, string> {
  const span = trace.getSpan(context.active());
  if (!span) return {};
  const sc = trace.getSpanContext(context.active());
  if (!sc || !trace.isSpanContextValid(sc)) return {};
  return { TRACEPARENT: `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2, "0")}` };
}
