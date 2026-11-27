// Trace headers on published task results (#259): from the active span, or from the caller.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { context, trace, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { publishResult, type PublishResultOptions } from "../src/nats/index.ts";
import { traceHeaders } from "../src/trace-context.ts";
import type { TaskResult } from "../src/contract/index.ts";

const result: TaskResult = {
  task_id: "t1", knight: "K", success: true, result: "done", duration_ms: 1, cost: 0,
  tokens: { input: 0, output: 0 }, model: "m", timestamp: new Date().toISOString(),
};

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

/** A js that fails with `errors` in order, then works; records the headers of every attempt. */
function fixture(errors: unknown[]) {
  let t = 0;
  const headers: Array<{ traceparent?: string; tracestate?: string } | undefined> = [];
  const opts: PublishResultOptions = {
    js: {
      publish: (async (_subject: string, _p: unknown, o?: { msgID?: string; headers?: { get(k: string): string | undefined } }) => {
        headers.push(o?.headers && { traceparent: o.headers.get("traceparent"), tracestate: o.headers.get("tracestate") });
        const e = errors.shift();
        if (e) throw e;
        return { seq: 1 };
      }) as never,
    },
    sleep: async (ms) => { t += ms; },
    now: () => t,
    retryMs: 60_000,
  };
  return { opts, headers };
}

describe("publishResult trace headers (#259)", () => {
  it("sends the active span's traceparent and tracestate, the same on every retry", async () => {
    const cm = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(cm);
    try {
      const sc = { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: TraceFlags.SAMPLED, traceState: undefined };
      const f = fixture([new Error("timeout")]);
      await context.with(trace.setSpanContext(context.active(), sc), () => publishResult("t1", result, f.opts));
      assert.equal(f.headers.length, 2);
      for (const h of f.headers) assert.equal(h?.traceparent, `00-${TRACE_ID}-${SPAN_ID}-01`);
    } finally {
      context.disable();
    }
  });

  it("sends no headers without an active span", async () => {
    const f = fixture([]);
    await publishResult("t1", result, f.opts);
    assert.equal(f.headers[0], undefined);
  });

  it("uses the traceHeaders option when the span has ended, and keeps MsgID", async () => {
    let msgID: string | undefined;
    const hdrs: Array<string | undefined> = [];
    const opts: PublishResultOptions = {
      js: {
        publish: (async (_s: string, _p: unknown, o?: { msgID?: string; headers?: { get(k: string): string | undefined } }) => {
          msgID = o?.msgID;
          hdrs.push(o?.headers?.get("traceparent"));
          return { seq: 1 };
        }) as never,
      },
      traceHeaders: { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`, tracestate: "a=b" },
    };
    await publishResult("t1", result, opts);
    assert.equal(msgID, "result-t1");
    assert.deepEqual(hdrs, [`00-${TRACE_ID}-${SPAN_ID}-01`]);
  });

  it("sends no headers when the traceHeaders option is empty", async () => {
    const f = fixture([]);
    await publishResult("t1", result, { ...f.opts, traceHeaders: {} });
    assert.equal(f.headers[0], undefined);
  });
});

describe("traceHeaders (#259)", () => {
  it("is empty without a valid span", () => {
    assert.deepEqual(traceHeaders(), {});
  });
});
