import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { trace, metrics } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { initLogger, log, setLogStream } from "../src/logger.js";
import { startTelemetry, telemetryEnabled, resourceDefaults, withTaskSpan } from "../src/telemetry.js";
import { traceparentEnv } from "../src/trace-context.js";

// Knight pods set OTEL_* variables (OTEL_SDK_DISABLED=true when telemetry is off), and the
// NodeSDK reads process.env itself. Clear them for every test and restore them afterwards,
// so these tests pass whatever the surrounding environment sets.
const ambientOtel = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("OTEL_")));
function clearOtelEnv(): void {
  for (const k of Object.keys(process.env)) if (k.startsWith("OTEL_")) delete process.env[k];
}

beforeEach(clearOtelEnv);
afterEach(() => {
  trace.disable();
  clearOtelEnv();
  Object.assign(process.env, ambientOtel);
});

test("OTEL_SDK_DISABLED=true (as on knight pods) keeps the bootstrap off even with an exporter set", async () => {
  process.env.OTEL_SDK_DISABLED = "true";
  process.env.OTEL_TRACES_EXPORTER = "otlp";
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const t = await startTelemetry({ service: "s", knight: "k", spanProcessors: [processor] });
  assert.equal(t.enabled, false);
  await withTaskSpan({ taskId: "t", knight: "k" }, async () => 1);
  await processor.forceFlush();
  assert.equal(exporter.getFinishedSpans().length, 0);
  await t.shutdown();
});

test("telemetry stays off without OTEL_* env, with OTEL_SDK_DISABLED, and registers nothing", async () => {
  assert.equal(telemetryEnabled({}), false);
  assert.equal(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_SDK_DISABLED: "true" }), false);
  assert.equal(telemetryEnabled({ OTEL_TRACES_EXPORTER: "otlp" }), true);
  const t = await startTelemetry({ service: "pi-knight", knight: "k", env: {} });
  assert.equal(t.enabled, false);
  await t.shutdown();
  // The global provider is still the no-op proxy: spans are not recording.
  const span = trace.getTracer("x").startSpan("s");
  assert.equal(span.isRecording(), false);
  assert.deepEqual(traceparentEnv(), {});
});

test("resource defaults add knight/table/service unless the env already sets them", () => {
  assert.deepEqual(resourceDefaults({ service: "pi-knight", knight: "galahad", env: {} }), {
    "service.name": "pi-knight",
    "roundtable.knight": "galahad",
    "roundtable.knight.runtime": "pi",
    "roundtable.table": "none",
  });
  assert.deepEqual(
    resourceDefaults({
      service: "pi-knight",
      knight: "galahad",
      env: { ROUNDTABLE_TABLE: "dev", OTEL_SERVICE_NAME: "x", OTEL_RESOURCE_ATTRIBUTES: "roundtable.knight=other,a=b" },
    }),
    { "roundtable.knight.runtime": "pi", "roundtable.table": "dev" },
  );
});

test("one task yields one invoke_agent root span with attributes; logs inside carry trace_id", async () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const t = await startTelemetry({
    service: "pi-knight",
    knight: "galahad",
    table: "dev",
    env: { OTEL_TRACES_EXPORTER: "otlp" },
    spanProcessors: [processor],
  });
  assert.equal(t.enabled, true);

  const chunks: string[] = [];
  setLogStream(new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } }));
  initLogger("galahad", "info", "dev");

  let tp: Record<string, string> = {};
  await withTaskSpan(
    { taskId: "t1", runId: "r1", attempt: 2, knight: "galahad", table: "dev", model: "m" },
    async () => {
      log.info("inside");
      tp = traceparentEnv();
      return { ok: true, cost: 0.5 };
    },
    (r) => ({ success: r.ok, cost: r.cost, model: "m2" }),
  );
  log.info("outside");
  await processor.forceFlush();
  const spans = exporter.getFinishedSpans(); // shutdown() resets the exporter
  await t.shutdown();

  assert.equal(spans.length, 1);
  const s = spans[0]!;
  assert.equal(s.name, "invoke_agent galahad");
  assert.equal(s.parentSpanContext, undefined);
  assert.equal(s.attributes["roundtable.task.id"], "t1");
  assert.equal(s.attributes["roundtable.run.id"], "r1");
  assert.equal(s.attributes["roundtable.knight"], "galahad");
  assert.equal(s.attributes["roundtable.table"], "dev");
  assert.equal(s.attributes["gen_ai.operation.name"], "invoke_agent");
  assert.equal(s.attributes["gen_ai.agent.name"], "galahad");
  assert.equal(s.attributes["gen_ai.request.model"], "m");
  assert.equal(s.attributes["gen_ai.response.model"], "m2");
  assert.equal(s.attributes["roundtable.attempt"], 2);
  assert.equal(s.attributes["roundtable.cost.usd"], 0.5);
  assert.equal(s.attributes["roundtable.task.success"], undefined);
  assert.equal(s.resource.attributes["roundtable.knight.runtime"], "pi");
  // Traces only: no meter provider is registered.
  assert.equal(metrics.getMeterProvider().constructor.name, "NoopMeterProvider");
  assert.equal(s.resource.attributes["service.name"], "pi-knight");
  assert.equal(s.resource.attributes["roundtable.knight"], "galahad");
  assert.equal(s.resource.attributes["roundtable.table"], "dev");

  const lines = chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const inside = lines.find((l) => l.msg === "inside");
  const outside = lines.find((l) => l.msg === "outside");
  assert.equal(inside.trace_id, s.spanContext().traceId);
  assert.equal(inside.span_id, s.spanContext().spanId);
  assert.equal(outside.trace_id, undefined);
  assert.equal(tp["TRACEPARENT"], `00-${s.spanContext().traceId}-${s.spanContext().spanId}-01`);
});

test("a throwing task still ends its span with error status", async () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const t = await startTelemetry({ service: "s", knight: "k", env: { OTEL_TRACES_EXPORTER: "otlp" }, spanProcessors: [processor] });
  await assert.rejects(withTaskSpan({ taskId: "t", knight: "k" }, async () => { throw new Error("boom"); }), /boom/);
  await processor.forceFlush();
  const [s] = exporter.getFinishedSpans();
  await t.shutdown();
  assert.equal(s!.status.code, 2);
});

async function spanWithParent(parent?: { traceparent?: string; tracestate?: string }) {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const t = await startTelemetry({ service: "s", knight: "k", env: { OTEL_TRACES_EXPORTER: "otlp" }, spanProcessors: [processor] });
  let logged = "";
  await withTaskSpan({ taskId: "t", knight: "k", parent }, async () => { logged = trace.getActiveSpan()!.spanContext().traceId; return 1; });
  await processor.forceFlush();
  const spans = exporter.getFinishedSpans();
  await t.shutdown();
  assert.equal(spans.length, 1);
  assert.equal(logged, spans[0]!.spanContext().traceId);
  return spans[0]!;
}

test("a valid traceparent makes the task span its child", async () => {
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const s = await spanWithParent({ traceparent: `00-${traceId}-00f067aa0ba902b7-01`, tracestate: "a=b" });
  assert.equal(s.spanContext().traceId, traceId);
  assert.equal(s.parentSpanContext?.spanId, "00f067aa0ba902b7");
});

test("missing or malformed trace headers give a root span", async () => {
  for (const parent of [undefined, {}, { traceparent: "garbage" }, { traceparent: `00-${"0".repeat(32)}-${"0".repeat(16)}-01` }]) {
    trace.disable(); // a fresh SDK per case
    const s = await spanWithParent(parent);
    assert.equal(s.parentSpanContext, undefined);
  }
});

test("task span carries runtime, chain, step and token usage; absent when unset", async () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const t = await startTelemetry({ service: "pi-knight", knight: "k", env: { OTEL_TRACES_EXPORTER: "otlp" }, spanProcessors: [processor] });
  await withTaskSpan(
    { taskId: "a", knight: "k", runtime: "claude", chain: "c1", step: "s1" },
    async () => 1,
    () => ({ success: true, tokens: { input: 100, output: 20, cacheRead: 50 } }),
  );
  await withTaskSpan({ taskId: "b", knight: "k" }, async () => 1, () => ({ success: true, tokens: { input: 7, output: 3 } }));
  await processor.forceFlush();
  const [a, b] = exporter.getFinishedSpans();
  await t.shutdown();
  assert.equal(a!.attributes["roundtable.knight.runtime"], "claude");
  assert.equal(a!.attributes["roundtable.chain"], "c1");
  assert.equal(a!.attributes["roundtable.chain.step"], "s1");
  assert.equal(a!.attributes["gen_ai.usage.input_tokens"], 150);
  assert.equal(a!.attributes["gen_ai.usage.output_tokens"], 20);
  assert.equal(a!.attributes["gen_ai.usage.cache_read.input_tokens"], 50);
  for (const k of ["roundtable.chain", "roundtable.chain.step", "roundtable.knight.runtime", "gen_ai.usage.cache_read.input_tokens"]) {
    assert.equal(k in b!.attributes, false, k);
  }
  assert.equal(b!.attributes["gen_ai.usage.input_tokens"], 7);
});
