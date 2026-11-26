import { context, trace } from "@opentelemetry/api";

/** Trace and span ids of the active recording span, for log lines. */
export function activeTraceIds(): { trace_id: string; span_id: string } | undefined {
  const span = trace.getSpan(context.active());
  if (!span?.isRecording()) return undefined;
  const { traceId, spanId } = span.spanContext();
  return { trace_id: traceId, span_id: spanId };
}

/** `TRACEPARENT` for a child process, from the active span; empty when there is none. */
export function traceparentEnv(): Record<string, string> {
  const sc = trace.getSpanContext(context.active());
  if (!sc || !trace.isSpanContextValid(sc)) return {};
  return { TRACEPARENT: `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2, "0")}` };
}

/** `traceparent`/`tracestate` for an outgoing message, from the active span; empty when there is none. */
export function traceHeaders(): Record<string, string> {
  const sc = trace.getSpanContext(context.active());
  if (!sc || !trace.isSpanContextValid(sc)) return {};
  const out: Record<string, string> = {
    traceparent: `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2, "0")}`,
  };
  const state = sc.traceState?.serialize();
  if (state) out.tracestate = state;
  return out;
}

const TRACEPARENT_RE = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}/;

/** Trace id of a W3C `traceparent` header; undefined when it is missing, malformed or all zeros. */
export function traceIdFromTraceparent(traceparent: string | undefined): string | undefined {
  const id = traceparent ? TRACEPARENT_RE.exec(traceparent.trim().toLowerCase())?.[1] : undefined;
  return id && !/^0+$/.test(id) ? id : undefined;
}

/** Trace id of the active span, when there is a valid one (an SDK is registered). */
export function activeTraceId(): string | undefined {
  const sc = trace.getSpanContext(context.active());
  return sc && trace.isSpanContextValid(sc) ? sc.traceId : undefined;
}
