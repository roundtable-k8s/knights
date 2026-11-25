import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { initLogger, log, setLogStream } from "../src/logger.js";
import { startTelemetry, telemetryEnabled, resourceDefaults, withTaskSpan, traceparentEnv } from "../src/telemetry.js";

afterEach(() => trace.disable());

test("telemetry stays off without OTEL_* env, with OTEL_SDK_DISABLED, and registers nothing", async () => {
  assert.equal(telemetryEnabled({}), false);
  assert.equal(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_SDK_DISABLED: "true" }), false);
  assert.equal(telemetryEnabled({ OTEL_TRACES_EXPORTER: "otlp" }), true);
  const t = startTelemetry({ service: "pi-knight", knight: "k", env: {} });
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
    "roundtable.table": "none",
  });
  assert.deepEqual(
    resourceDefaults({
      service: "pi-knight",
      knight: "galahad",
      env: { ROUNDTABLE_TABLE: "dev", OTEL_SERVICE_NAME: "x", OTEL_RESOURCE_ATTRIBUTES: "roundtable.knight=other,a=b" },
    }),
    { "roundtable.table": "dev" },
  );
});

test("one task yields one knight.task root span with attributes; logs inside carry trace_id", async () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const t = startTelemetry({
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
    { taskId: "t1", runId: "r1", knight: "galahad", table: "dev", model: "m" },
    async () => {
      log.info("inside");
      tp = traceparentEnv();
      return { ok: true, cost: 0.5 };
    },
    (r) => ({ success: r.ok, cost: r.cost }),
  );
  log.info("outside");
  await processor.forceFlush();
  const spans = exporter.getFinishedSpans(); // shutdown() resets the exporter
  await t.shutdown();

  assert.equal(spans.length, 1);
  const s = spans[0]!;
  assert.equal(s.name, "knight.task");
  assert.equal(s.parentSpanContext, undefined);
  assert.equal(s.attributes["roundtable.task.id"], "t1");
  assert.equal(s.attributes["roundtable.run.id"], "r1");
  assert.equal(s.attributes["roundtable.knight"], "galahad");
  assert.equal(s.attributes["roundtable.table"], "dev");
  assert.equal(s.attributes["roundtable.model"], "m");
  assert.equal(s.attributes["roundtable.task.success"], true);
  assert.equal(s.attributes["roundtable.task.cost"], 0.5);
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
  const t = startTelemetry({ service: "s", knight: "k", env: { OTEL_TRACES_EXPORTER: "otlp" }, spanProcessors: [processor] });
  await assert.rejects(withTaskSpan({ taskId: "t", knight: "k" }, async () => { throw new Error("boom"); }), /boom/);
  await processor.forceFlush();
  const [s] = exporter.getFinishedSpans();
  await t.shutdown();
  assert.equal(s!.status.code, 2);
  assert.equal(s!.attributes["roundtable.task.success"], false);
});
