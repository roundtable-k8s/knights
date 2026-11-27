import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { context, propagation, trace, metrics } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { initLogger, log, setLogStream } from "../src/logger.js";
import { startTelemetry, telemetryEnabled, type Telemetry, resourceDefaults, withTaskSpan } from "../src/telemetry.js";
import { traceparentEnv } from "../src/trace-context.js";
import { isolateOtelEnv } from "./helpers/otel-env.js";

let restoreOtelEnv = (): void => {};
beforeEach(() => {
  restoreOtelEnv = isolateOtelEnv();
});
afterEach(() => {
  resetOtelGlobals();
  restoreOtelEnv();
});

/** Drop every global OTel registration (tracer, propagator, context manager) so one SDK start cannot leak into the next. */
function resetOtelGlobals(): void {
  trace.disable();
  propagation.disable();
  context.disable();
}

/** Start telemetry, run fn, and always shut down and unregister the global tracer provider. */
async function withTelemetry<T>(opts: Parameters<typeof startTelemetry>[0], fn: (t: Telemetry) => Promise<T>): Promise<T> {
  const t = await startTelemetry(opts);
  try {
    return await fn(t);
  } finally {
    await t.shutdown();
    resetOtelGlobals();
  }
}

test("OTEL_SDK_DISABLED=true (as on knight pods) keeps the bootstrap off even with an exporter set", async () => {
  process.env.OTEL_SDK_DISABLED = "true";
  process.env.OTEL_TRACES_EXPORTER = "otlp";
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  await withTelemetry({ service: "s", knight: "k", spanProcessors: [processor] }, async (t) => {
    assert.equal(t.enabled, false);
    await withTaskSpan({ taskId: "t", knight: "k" }, async () => 1);
    await processor.forceFlush();
    assert.equal(exporter.getFinishedSpans().length, 0);
  });
});

test("telemetry stays off without OTEL_* env, with OTEL_SDK_DISABLED, and registers nothing", async () => {
  assert.equal(telemetryEnabled({}), false);
  assert.equal(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://c:4318", OTEL_SDK_DISABLED: "true" }), false);
  assert.equal(telemetryEnabled({ OTEL_TRACES_EXPORTER: "otlp" }), true);
  assert.equal(telemetryEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c/v1/traces" }), true);
  assert.equal(telemetryEnabled({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://c/v1/traces", OTEL_SDK_DISABLED: "true" }), false);
  await withTelemetry({ service: "pi-knight", knight: "k", env: {} }, async (t) => {
    assert.equal(t.enabled, false);
    // Nothing is registered: spans are not recording and metrics calls are harmless no-ops.
    const span = trace.getTracer("x").startSpan("s");
    assert.equal(span.isRecording(), false);
    assert.deepEqual(traceparentEnv(), {});
    assert.doesNotThrow(() => metrics.getMeter("x").createCounter("c").add(1));
  });
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
  const meterProviderBefore = metrics.getMeterProvider();
  const { finished: spans, lines, tp } = await withTelemetry(
    {
      service: "pi-knight",
      knight: "galahad",
      table: "dev",
      env: { OTEL_TRACES_EXPORTER: "otlp" },
      spanProcessors: [processor],
    },
    async (t) => {
      assert.equal(t.enabled, true);
      // Traces only: starting the SDK must not swap in a meter provider.
      assert.equal(metrics.getMeterProvider(), meterProviderBefore);

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
      const finished = exporter.getFinishedSpans(); // shutdown() resets the exporter
      const lines = chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return { finished, lines, tp };
    },
  );

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
  assert.equal(s.resource.attributes["service.name"], "pi-knight");
  assert.equal(s.resource.attributes["roundtable.knight"], "galahad");
  assert.equal(s.resource.attributes["roundtable.table"], "dev");

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
  const [s] = await withTelemetry({ service: "s", knight: "k", env: { OTEL_TRACES_EXPORTER: "otlp" }, spanProcessors: [processor] }, async () => {
    await assert.rejects(withTaskSpan({ taskId: "t", knight: "k" }, async () => { throw new Error("boom"); }), /boom/);
    await processor.forceFlush();
    return exporter.getFinishedSpans();
  });
  assert.equal(s!.status.code, 2);
});

async function spanWithParent(parent?: { traceparent?: string; tracestate?: string }) {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  let logged = "";
  const spans = await withTelemetry({ service: "s", knight: "k", env: { OTEL_TRACES_EXPORTER: "otlp" }, spanProcessors: [processor] }, async () => {
    await withTaskSpan({ taskId: "t", knight: "k", parent }, async () => { logged = trace.getActiveSpan()!.spanContext().traceId; return 1; });
    await processor.forceFlush();
    return exporter.getFinishedSpans();
  });
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
    resetOtelGlobals(); // a fresh SDK per case
    const s = await spanWithParent(parent);
    assert.equal(s.parentSpanContext, undefined);
  }
});

test("task span carries runtime, chain, step and token usage; absent when unset", async () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const [a, b, c] = await withTelemetry({ service: "pi-knight", knight: "k", env: { OTEL_TRACES_EXPORTER: "otlp" }, spanProcessors: [processor] }, async () => {
    await withTaskSpan(
      { taskId: "a", knight: "k", runtime: "claude", chain: "c1", step: "s1" },
      async () => 1,
      () => ({ success: true, tokens: { input: 100, output: 20, cacheRead: 50 } }),
    );
    await withTaskSpan({ taskId: "b", knight: "k" }, async () => 1, () => ({ success: true, tokens: { input: 7, output: 3 } }));
    await withTaskSpan({ taskId: "c", knight: "k" }, async () => 1, () => ({ success: true, tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 30 } }));
    await processor.forceFlush();
    return exporter.getFinishedSpans();
  });
  assert.equal(a!.attributes["roundtable.knight.runtime"], "claude");
  assert.equal(a!.attributes["roundtable.chain"], "c1");
  assert.equal(a!.attributes["roundtable.chain.step"], "s1");
  assert.equal(a!.attributes["gen_ai.usage.input_tokens"], 150);
  assert.equal(a!.attributes["gen_ai.usage.output_tokens"], 20);
  assert.equal(a!.attributes["gen_ai.usage.cache_read.input_tokens"], 50);
  assert.equal(a!.attributes["gen_ai.usage.cache_creation.input_tokens"], undefined);
  assert.equal(c!.attributes["gen_ai.usage.input_tokens"], 180);
  assert.equal(c!.attributes["gen_ai.usage.cache_creation.input_tokens"], 30);
  for (const k of ["roundtable.chain", "roundtable.chain.step", "roundtable.knight.runtime", "gen_ai.usage.cache_read.input_tokens", "gen_ai.usage.cache_creation.input_tokens"]) {
    assert.equal(k in b!.attributes, false, k);
  }
  assert.equal(b!.attributes["gen_ai.usage.input_tokens"], 7);
});

test("byte cut keeps real U+FFFD and never splits a character", async () => {
  const { setContentAttribute } = await import("../src/telemetry.js");
  const got: Record<string, unknown> = {};
  const span: any = { setAttribute: (k: string, v: unknown) => { got[k] = v; } };
  const env = { ROUNDTABLE_TELEMETRY_CONTENT_MAX_BYTES: "6" };
  setContentAttribute(span, "k", "ab��zzz", env);
  assert.equal(got["k"], "ab�");
  setContentAttribute(span, "k", "ééééé", env);
  assert.equal(got["k"], "ééé");
});

test("default OTLP path: with only OTEL_EXPORTER_OTLP_ENDPOINT the SDK exports spans to POST /v1/traces", async () => {
  const requests: { method?: string; url?: string; bytes: number }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, bytes: Buffer.concat(chunks).length });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    // No spanProcessors: the SDK builds its own batch processor and OTLP/HTTP exporter. The SDK reads
    // process.env (not opts.env), so set it there; the afterEach hook restores the ambient values.
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` };
    Object.assign(process.env, env);
    await withTelemetry(
      { service: "s", knight: "k", env },
      async (t) => {
        assert.equal(t.enabled, true);
        await withTaskSpan({ taskId: "t", knight: "k" }, async () => 1);
      },
    );
    const traces = requests.filter((r) => r.method === "POST" && r.url === "/v1/traces");
    assert.ok(traces.length >= 1, `expected POST /v1/traces, got ${JSON.stringify(requests)}`);
    assert.ok(traces[0]!.bytes > 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a stray percent sign in OTEL_RESOURCE_ATTRIBUTES does not stop telemetry; the value is kept as written and only the key is logged", async () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const chunks: string[] = [];
  setLogStream(new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } }));
  initLogger("galahad", "info", "dev");
  const env = { OTEL_TRACES_EXPORTER: "otlp", OTEL_RESOURCE_ATTRIBUTES: "a=50%,b=ok,c=x%zz" };
  Object.assign(process.env, env);
  const spans = await withTelemetry({ service: "s", knight: "k", env, spanProcessors: [processor] }, async (t) => {
    assert.equal(t.enabled, true);
    await withTaskSpan({ taskId: "t", knight: "k" }, async () => 1);
    await processor.forceFlush();
    return exporter.getFinishedSpans();
  });
  assert.equal(spans.length, 1);
  assert.equal(spans[0]!.resource.attributes["roundtable.knight"], "k");
  const logged = chunks.join("");
  assert.match(logged, /Invalid OTEL_RESOURCE_ATTRIBUTES entry, using it undecoded/);
  assert.doesNotMatch(logged, /50%|x%zz/);
  assert.deepEqual(resourceDefaults({ service: "s", knight: "k", env: { OTEL_RESOURCE_ATTRIBUTES: "a=50%" } }), {
    "service.name": "s",
    "roundtable.knight": "k",
    "roundtable.knight.runtime": "s",
    "roundtable.table": "none",
  });
});

test("a throwing span outcome still resolves to the task result, and the span ends without error status", async () => {
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const chunks: string[] = [];
  setLogStream(new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } }));
  initLogger("galahad", "info", "dev");
  const [result, spans] = await withTelemetry({ service: "s", knight: "k", env: { OTEL_TRACES_EXPORTER: "otlp" }, spanProcessors: [processor] }, async () => {
    const r = await withTaskSpan(
      { taskId: "t", knight: "k" },
      async () => ({ ok: true }),
      () => { throw new Error("outcome broke"); },
    );
    await processor.forceFlush();
    return [r, exporter.getFinishedSpans()] as const;
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(spans.length, 1);
  assert.notEqual(spans[0]!.status.code, 2);
  const warned = chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.msg === "Task span outcome could not be recorded");
  assert.ok(warned, "expected the outcome warn line");
  assert.equal(warned.level, "warn");
  assert.match(warned.error, /outcome broke/);
});

test("a throwing SDK loader leaves telemetry disabled, logs a warning and does not throw", async () => {
  const chunks: string[] = [];
  setLogStream(new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } }));
  initLogger("galahad", "info", "dev");
  const t = await startTelemetry({
    service: "pi-knight",
    knight: "k",
    env: { OTEL_TRACES_EXPORTER: "otlp" },
    loadSdk: async () => { throw new Error("sdk missing"); },
  });
  try {
    assert.equal(t.enabled, false);
    await t.shutdown(); // a no-op when disabled
    const warned = chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.msg === "OpenTelemetry could not start");
    assert.ok(warned, "expected the startup warn line");
    assert.equal(warned.level, "warn");
    assert.match(warned.error, /sdk missing/);
  } finally {
    resetOtelGlobals();
  }
});
