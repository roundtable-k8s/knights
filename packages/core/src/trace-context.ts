import { context, trace, type SpanContext } from "@opentelemetry/api";

/** Trace and span ids of the active recording span, for log lines. */
export function activeTraceIds(): { trace_id: string; span_id: string } | undefined {
  const span = trace.getSpan(context.active());
  if (!span?.isRecording()) return undefined;
  const { traceId, spanId } = span.spanContext();
  return { trace_id: traceId, span_id: spanId };
}

/** W3C `traceparent` value for a span context: always version `00`. */
function formatTraceparent(sc: SpanContext): string {
  return `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2, "0")}`;
}

/** `TRACEPARENT` for a child process, from the active span; empty when there is none. */
export function traceparentEnv(): Record<string, string> {
  const sc = trace.getSpanContext(context.active());
  if (!sc || !trace.isSpanContextValid(sc)) return {};
  return { TRACEPARENT: formatTraceparent(sc) };
}

/** `traceparent`/`tracestate` for an outgoing message, from the active span; empty when there is none. */
export function traceHeaders(): Record<string, string> {
  const sc = trace.getSpanContext(context.active());
  if (!sc || !trace.isSpanContextValid(sc)) return {};
  const out: Record<string, string> = { traceparent: formatTraceparent(sc) };
  const state = sc.traceState?.serialize();
  if (state) out.tracestate = state;
  return out;
}

// W3C traceparent, parsed like the OpenTelemetry propagator: lowercase hex only, no surrounding
// whitespace, version ff invalid, and version 00 must have exactly four fields. Other versions may
// carry extra fields after a '-'.
const TRACEPARENT_RE = /^([0-9a-f]{2})-((?!0{32})[0-9a-f]{32})-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}(-.+)?$/;

/** Trace id of a W3C `traceparent` header; undefined when it is missing, malformed or all zeros. */
export function traceIdFromTraceparent(traceparent: string | undefined): string | undefined {
  if (!traceparent) return undefined;
  const m = TRACEPARENT_RE.exec(traceparent);
  if (!m) return undefined;
  const [, version, traceId, extra] = m;
  if (version === "ff") return undefined;
  if (version === "00" && extra !== undefined) return undefined;
  return traceId;
}

/** Trace id of the active span, when there is a valid one (an SDK is registered). */
export function activeTraceId(): string | undefined {
  const sc = trace.getSpanContext(context.active());
  return sc && trace.isSpanContextValid(sc) ? sc.traceId : undefined;
}
