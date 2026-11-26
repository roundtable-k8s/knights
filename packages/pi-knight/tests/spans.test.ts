import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { trace } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { startTelemetry, withTaskSpan } from "@roundtable/knight-core";
import { SessionSpans } from "../src/spans.ts";

const keep = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("OTEL_")));
const clear = () => { for (const k of Object.keys(process.env)) if (k.startsWith("OTEL_")) delete process.env[k]; };
beforeEach(clear);
afterEach(() => { trace.disable(); clear(); Object.assign(process.env, keep); });

const msg = (extra: any = {}) => ({ type: "message_end", message: { role: "assistant", model: "m-resp", usage: { input: 10, output: 5 }, content: [{ type: "text", text: "SECRET" }], ...extra } });
const events = (toolError = false): any[] => [
  { type: "turn_start" },
  msg(),
  { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { cmd: "SECRET" } },
  { type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: toolError, result: { content: "SECRET" } },
  { type: "turn_start" },
  msg({ usage: { input: 20, output: 7 } }),
];

async function setup() {
  process.env.OTEL_TRACES_EXPORTER = "otlp";
  const exporter = new InMemorySpanExporter();
  const processor = new SimpleSpanProcessor(exporter);
  const t = await startTelemetry({ service: "pi-knight", knight: "k", spanProcessors: [processor] });
  return { exporter, t, processor };
}

test("two turns and one tool call export chat/execute_tool children of invoke_agent", async () => {
  const { exporter, t, processor } = await setup();
  await withTaskSpan({ taskId: "t1", knight: "k", table: "tbl" }, async () => {
    const s = new SessionSpans("p/m", { knight: "k", table: "tbl" });
    for (const e of events()) s.handle(e);
    s.endAll();
  });
  await processor.forceFlush();
  const spans = exporter.getFinishedSpans();
  const root = spans.find((s) => s.name === "invoke_agent k")!;
  const chats = spans.filter((s) => s.name === "chat p/m");
  const tools = spans.filter((s) => s.name === "execute_tool bash");
  assert.equal(spans.length, 4);
  assert.equal(chats.length, 2);
  assert.equal(tools.length, 1);
  for (const c of [...chats, ...tools]) {
    assert.equal(c.parentSpanContext?.spanId, root.spanContext().spanId);
    assert.equal(c.attributes["roundtable.knight"], "k");
    assert.equal(c.attributes["roundtable.table"], "tbl");
  }
  assert.equal(chats[0].attributes["gen_ai.operation.name"], "chat");
  assert.equal(chats[0].attributes["gen_ai.request.model"], "p/m");
  assert.equal(chats[0].attributes["gen_ai.response.model"], "m-resp");
  assert.equal(chats[0].attributes["gen_ai.usage.input_tokens"], 10);
  assert.equal(chats[1].attributes["gen_ai.usage.output_tokens"], 7);
  assert.equal(tools[0].attributes["gen_ai.operation.name"], "execute_tool");
  assert.equal(tools[0].attributes["gen_ai.tool.name"], "bash");
  assert.equal(tools[0].attributes["gen_ai.tool.call.id"], "c1");
  assert.equal(tools[0].status.code, 0);
  assert.ok(!JSON.stringify(spans.map((s) => s.attributes)).includes("SECRET"));
  await t.shutdown();
});

test("a tool call with isError yields an error-status span", async () => {
  const { exporter, t, processor } = await setup();
  await withTaskSpan({ taskId: "t", knight: "k" }, async () => {
    const s = new SessionSpans("p/m", { knight: "k" });
    for (const e of events(true)) s.handle(e);
    s.endAll();
  });
  await processor.forceFlush();
  assert.equal(exporter.getFinishedSpans().find((s) => s.name === "execute_tool bash")!.status.code, 2);
  await t.shutdown();
});

test("endAll closes spans left open by an aborted task", async () => {
  const { exporter, t, processor } = await setup();
  await withTaskSpan({ taskId: "t", knight: "k" }, async () => {
    const s = new SessionSpans("p/m", { knight: "k" });
    s.handle({ type: "turn_start" });
    s.handle({ type: "tool_execution_start", toolCallId: "c9", toolName: "read" });
    s.endAll();
    s.endAll();
  });
  await processor.forceFlush();
  assert.deepEqual(exporter.getFinishedSpans().map((s) => s.name).sort(), ["chat p/m", "execute_tool read", "invoke_agent k"]);
  await t.shutdown();
});

test("no spans and no errors when no SDK is registered", async () => {
  const s = new SessionSpans("p/m", { knight: "k" });
  for (const e of events(true)) s.handle(e);
  s.endAll();
});
