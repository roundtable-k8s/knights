import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { SpanStatusCode, trace } from "@opentelemetry/api";
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
  assert.equal(chats[0]!.attributes["gen_ai.operation.name"], "chat");
  assert.equal(chats[0]!.attributes["gen_ai.request.model"], "p/m");
  assert.equal(chats[0]!.attributes["gen_ai.response.model"], "m-resp");
  assert.equal(chats[0]!.attributes["gen_ai.usage.input_tokens"], 10);
  assert.equal(chats[1]!.attributes["gen_ai.usage.output_tokens"], 7);
  assert.equal(tools[0]!.attributes["gen_ai.operation.name"], "execute_tool");
  assert.equal(tools[0]!.attributes["gen_ai.tool.name"], "bash");
  assert.equal(tools[0]!.attributes["gen_ai.tool.call.id"], "c1");
  assert.equal(tools[0]!.status.code, SpanStatusCode.UNSET);
  assert.match(String(chats[0]!.attributes["gen_ai.output.messages"]), /SECRET/);
  assert.equal(tools[0]!.attributes["gen_ai.tool.call.arguments"], '{"cmd":"SECRET"}');
  assert.equal(tools[0]!.attributes["gen_ai.tool.call.result"], "SECRET");
  assert.equal(chats[0]!.attributes["gen_ai.system_instructions"], undefined);
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
  assert.equal(exporter.getFinishedSpans().find((s) => s.name === "execute_tool bash")!.status.code, SpanStatusCode.ERROR);
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

const TOKEN = "sk-ant-api03-abcdefghijklmnop";

async function run(env: Record<string, string> = {}, evs: any[] = events()) {
  Object.assign(process.env, env);
  const { exporter, t, processor } = await setup();
  await withTaskSpan({ taskId: "t", knight: "k" }, async () => {
    const s = new SessionSpans("p/m", { knight: "k" }, undefined, () => `system ${TOKEN}`);
    for (const e of evs) s.handle(e);
    s.endAll();
  });
  await processor.forceFlush();
  const spans = exporter.getFinishedSpans();
  await t.shutdown();
  return spans;
}
const CONTENT_ENV = ["ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT", "ROUNDTABLE_TELEMETRY_CONTENT_MAX_BYTES"];
afterEach(() => { for (const k of CONTENT_ENV) delete process.env[k]; });

test("secrets are redacted before reaching any span attribute", async () => {
  const evs = [
    { type: "turn_start" },
    { type: "message_end", message: { role: "user", content: `use ${TOKEN}` } },
    { type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { cmd: TOKEN } },
    { type: "tool_execution_end", toolCallId: "c", toolName: "bash", result: { content: [{ type: "text", text: TOKEN }] } },
    msg({ content: [{ type: "text", text: TOKEN }] }),
  ];
  const spans = await run({}, [{ type: "turn_start" }, ...evs]);
  const all = JSON.stringify(spans.map((s) => s.attributes));
  assert.ok(!all.includes(TOKEN));
  assert.match(all, /REDACTED/i);
  assert.match(String(spans.find((s) => s.name === "chat p/m")!.attributes["gen_ai.system_instructions"]), /system/);
});

test("oversize content is cut at the cap and flagged", async () => {
  const big = "a".repeat(5000);
  const spans = await run({ ROUNDTABLE_TELEMETRY_CONTENT_MAX_BYTES: "100" }, [
    { type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: big },
    { type: "tool_execution_end", toolCallId: "c", toolName: "bash", result: { content: "ok" } },
  ]);
  const tool = spans.find((s) => s.name === "execute_tool bash")!;
  assert.equal(Buffer.byteLength(String(tool.attributes["gen_ai.tool.call.arguments"])), 100);
  assert.equal(tool.attributes["roundtable.content.truncated"], true);
  assert.equal(tool.attributes["gen_ai.tool.call.result"], "ok");
});

test("ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT=false leaves content unset but keeps tokens", async () => {
  const spans = await run({ ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT: "false" });
  const keys = spans.flatMap((s) => Object.keys(s.attributes));
  assert.ok(!keys.some((k) => /input\.messages|output\.messages|system_instructions|tool\.call\.(arguments|result)|content\.truncated/.test(k)));
  const chat = spans.find((s) => s.name === "chat p/m")!;
  assert.equal(chat.attributes["gen_ai.usage.input_tokens"], 10);
  assert.ok(spans.some((s) => s.attributes["gen_ai.tool.name"] === "bash"));
});

test("the first chat span records the prompt (real event order: turn_start precedes the prompt)", async () => {
  const spans = await run({}, [
    { type: "agent_start" },
    { type: "turn_start" },
    { type: "message_start", message: { role: "user" } },
    { type: "message_end", message: { role: "user", content: [{ type: "text", text: "please fix the bug" }] } },
    msg({ content: [{ type: "text", text: "ok" }, { type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "ls" } }] }),
    { type: "turn_start" },
    { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "file.txt" }] } },
    msg(),
  ]);
  const chats = spans.filter((s) => s.name === "chat p/m");
  assert.deepEqual(JSON.parse(String(chats[0]!.attributes["gen_ai.input.messages"])), [{ role: "user", content: "please fix the bug" }]);
  const second = JSON.parse(String(chats[1]!.attributes["gen_ai.input.messages"]));
  assert.deepEqual(second.map((m: any) => m.role), ["user", "assistant", "toolResult"]);
  const out = JSON.parse(String(chats[0]!.attributes["gen_ai.output.messages"]));
  assert.deepEqual(out[0].tool_calls, [{ id: "c1", name: "bash", arguments: { cmd: "ls" } }]);
});

test("input history keeps the newest messages when over the cap", async () => {
  const spans = await run({ ROUNDTABLE_TELEMETRY_CONTENT_MAX_BYTES: "200" }, [
    { type: "turn_start" },
    { type: "message_end", message: { role: "user", content: "OLDEST " + "x".repeat(150) } },
    msg(),
    { type: "turn_start" },
    { type: "message_end", message: { role: "user", content: "NEWEST " + "y".repeat(100) } },
    msg(),
  ]);
  const chat = spans.filter((s) => s.name === "chat p/m")[1];
  const input = String(chat!.attributes["gen_ai.input.messages"]);
  assert.match(input, /NEWEST/);
  assert.ok(!input.includes("OLDEST"));
  assert.equal(chat!.attributes["roundtable.content.truncated"], true);
});

test("input history stays valid JSON within the cap for escaping-heavy content", async () => {
  const cap = 400;
  const nasty = ['"q"'.repeat(60), "line\n".repeat(60), "😀\\".repeat(60), "x".repeat(5000)];
  const events: any[] = [];
  for (const c of nasty) {
    events.push({ type: "turn_start" }, { type: "message_end", message: { role: "user", content: c } }, msg());
  }
  const spans = await run({ ROUNDTABLE_TELEMETRY_CONTENT_MAX_BYTES: String(cap) }, events);
  const chats = spans.filter((s) => s.name === "chat p/m");
  assert.equal(chats.length, nasty.length);
  for (const chat of chats) {
    const input = String(chat.attributes["gen_ai.input.messages"]);
    assert.ok(Buffer.byteLength(input) <= cap, `size ${Buffer.byteLength(input)}`);
    const parsed = JSON.parse(input);
    assert.ok(parsed.length >= 1);
    assert.ok(!input.includes("\ufffd"));
  }
});

test("compaction and retry events land on the task span with redacted, bounded error text", async () => {
  const { exporter, t, processor } = await setup();
  await withTaskSpan({ taskId: "t1", knight: "k", table: "tbl" }, async () => {
    const s = new SessionSpans("p/m", { knight: "k", table: "tbl" });
    s.handle({ type: "compaction_start", reason: "threshold" });
    s.handle({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: true });
    s.handle({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: "summariser failed" });
    s.handle({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "boom ghp_" + "a".repeat(36) + " " + "x".repeat(2000) });
    s.handle({ type: "auto_retry_end", success: false, attempt: 3, finalError: "gave up" });
    s.endAll();
  });
  await processor.forceFlush();
  const root = exporter.getFinishedSpans().find((s) => s.name === "invoke_agent k")!;
  const ev = root.events;
  assert.deepEqual(ev.map((e) => e.name), ["compaction", "compaction", "llm.retry", "llm.retry"]);
  assert.deepEqual(ev[0]!.attributes, { reason: "threshold", aborted: false, will_retry: true });
  assert.deepEqual(ev[1]!.attributes, { reason: "overflow", aborted: false, will_retry: false, error: "summariser failed" });
  assert.equal(ev[2]!.attributes!["attempt"], 1);
  assert.equal(ev[2]!.attributes!["max_attempts"], 3);
  assert.equal(ev[2]!.attributes!["delay_ms"], 2000);
  const err = String(ev[2]!.attributes!["error"]);
  assert.ok(!err.includes("ghp_"));
  assert.ok(err.length <= 500);
  assert.deepEqual(ev[3]!.attributes, { attempt: 3, success: false, error: "gave up" });
  await t.shutdown?.();
});

test("compaction and retry events are no-ops without an SDK", () => {
  const s = new SessionSpans("p/m", { knight: "k" });
  s.handle({ type: "compaction_end", reason: "threshold", aborted: false });
  s.handle({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "x" });
  s.handle({ type: "auto_retry_end", success: true, attempt: 1 });
});
