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
