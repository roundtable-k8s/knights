import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { context, trace, ROOT_CONTEXT, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { activeTraceId, traceHeaders, traceIdFromTraceparent, traceparentEnv } from "../src/trace-context.js";

const TID = "0af7651916cd43dd8448eb211c80319c";
const SID = "b7ad6b7169203331";

test("traceIdFromTraceparent: extracts the trace id of a valid header", () => {
  assert.equal(traceIdFromTraceparent(`00-${TID}-${SID}-01`), TID);
  assert.equal(traceIdFromTraceparent(`01-${TID}-${SID}-01-extra-data`), TID);
});

test("traceIdFromTraceparent: version 00 must have exactly four fields", () => {
  assert.equal(traceIdFromTraceparent(`00-${TID}-${SID}-01-extra`), undefined);
  assert.equal(traceIdFromTraceparent(`00-${TID}-${SID}-01-`), undefined);
});

test("traceIdFromTraceparent: no trimming of surrounding whitespace", () => {
  assert.equal(traceIdFromTraceparent(`  00-${TID}-${SID}-00 `), undefined);
  assert.equal(traceIdFromTraceparent(`00-${TID}-${SID}-00 `), undefined);
  assert.equal(traceIdFromTraceparent(` 00-${TID}-${SID}-00`), undefined);
  assert.equal(traceIdFromTraceparent(`00-${TID}-${SID}-00\n`), undefined);
});

test("traceIdFromTraceparent: rejects missing and malformed headers", () => {
  assert.equal(traceIdFromTraceparent(undefined), undefined);
  assert.equal(traceIdFromTraceparent(""), undefined);
  assert.equal(traceIdFromTraceparent("garbage"), undefined);
  assert.equal(traceIdFromTraceparent(`00-${TID.slice(1)}-${SID}-01`), undefined);
});

test("traceIdFromTraceparent: rejects what the OpenTelemetry parser rejects", () => {
  assert.equal(traceIdFromTraceparent(`00-${TID.toUpperCase()}-${SID}-01`), undefined);
  assert.equal(traceIdFromTraceparent(`ff-${TID}-${SID}-01`), undefined);
  assert.equal(traceIdFromTraceparent(`00-${"0".repeat(32)}-${SID}-01`), undefined);
  assert.equal(traceIdFromTraceparent(`ff-${TID}-${SID}-01-extra`), undefined);
  assert.equal(traceIdFromTraceparent(`00-${TID}-${"0".repeat(16)}-01`), undefined);
});

before(() => context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable()));
after(() => context.disable());

test("traceparent formatter: one format for env and headers", () => {
  const ctx = trace.setSpanContext(ROOT_CONTEXT, { traceId: TID, spanId: SID, traceFlags: TraceFlags.SAMPLED });
  const want = `00-${TID}-${SID}-01`;
  assert.deepEqual(context.with(ctx, traceparentEnv), { TRACEPARENT: want });
  assert.deepEqual(context.with(ctx, traceHeaders), { traceparent: want });
  assert.equal(traceIdFromTraceparent(want), TID);
});

test("activeTraceId: undefined without an active span", () => {
  assert.equal(activeTraceId(), undefined);
});

test("activeTraceId: trace id of a valid active span context", () => {
  const ctx = trace.setSpanContext(ROOT_CONTEXT, { traceId: TID, spanId: SID, traceFlags: TraceFlags.SAMPLED });
  assert.equal(context.with(ctx, activeTraceId), TID);
});

test("activeTraceId: ignores an invalid span context", () => {
  const ctx = trace.setSpanContext(ROOT_CONTEXT, { traceId: "0".repeat(32), spanId: SID, traceFlags: 0 });
  assert.equal(context.with(ctx, activeTraceId), undefined);
});
