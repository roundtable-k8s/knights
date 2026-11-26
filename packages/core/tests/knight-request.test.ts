import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { context, trace, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { MsgHdrs } from "@nats-io/transport-node";
import { publishOutOfBand, requestKnight, type NatsHandles } from "../src/knight-request.ts";

interface Published {
  subject: string;
  payload: string;
  headers?: MsgHdrs;
}

/**
 * A fake connection: `reply` pushes a result message, `fail` makes the subscription throw.
 * `publishError` makes every publish reject with that error.
 */
function fakeConn(publishError?: Error) {
  const published: Published[] = [];
  const subjects: string[] = [];
  let unsubscribed = false;
  let push: (raw: string) => void = () => {};
  let end: (err?: Error) => void = () => {};
  const nc = {
    subscribe(subject: string) {
      subjects.push(subject);
      const queue: string[] = [];
      let wake: (() => void) | undefined;
      let done = false;
      let error: Error | undefined;
      push = (raw) => { queue.push(raw); wake?.(); };
      end = (err) => { done = true; error = err; wake?.(); };
      return {
        unsubscribe() { unsubscribed = true; end(); },
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length) { const raw = queue.shift()!; yield { string: () => raw }; return; }
            if (done) { if (error) throw error; return; }
            await new Promise<void>((r) => { wake = r; });
          }
        },
      };
    },
  };
  const js = {
    async publish(subject: string, payload: string, opts?: { headers?: MsgHdrs }) {
      if (publishError) throw publishError;
      published.push({ subject, payload, headers: opts?.headers });
      return { seq: 1 };
    },
  };
  const conn = { nc, js } as unknown as NatsHandles;
  return { conn, published, subjects, reply: (raw: string) => push(raw), fail: (e: Error) => end(e), wasUnsubscribed: () => unsubscribed };
}

const base = { knightName: "Gawain", prefix: "rt-dev", knight: "galahad", domain: "security", task: "check it" };
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("requestKnight", () => {
  it("publishes the task and returns the reply", async () => {
    const f = fakeConn();
    const p = requestKnight({ ...base, conn: f.conn, timeoutMs: 5000 });
    await tick();
    f.reply(JSON.stringify({ success: true, result: "all clear", cost: 0.5, duration_ms: 2000 }));
    const r = await p;
    assert.equal(r.ok, true);
    assert.match(r.text, /Response from galahad \(2s, \$0\.5000\):\n\nall clear/);
    assert.equal(f.published.length, 1);
    const pub = f.published[0]!;
    assert.match(pub.subject, /^rt-dev\.tasks\.security\.galahad-xreq-/);
    assert.match(f.subjects[0]!, /^rt-dev\.results\.galahad-xreq-/);
    const body = JSON.parse(pub.payload);
    assert.equal(body.task, "check it");
    assert.equal(body.domain, "security");
    assert.equal(body.from, "gawain");
    assert.equal(body.dispatched_by, "Gawain");
    assert.deepEqual(body.metadata, { timeout_ms: 5000, table_prefix: "rt-dev" });
    assert.equal(body.task_id, pub.subject.split(".").pop());
  });

  it("reports the error field of a failure reply", async () => {
    const f = fakeConn();
    const p = requestKnight({ ...base, conn: f.conn });
    await tick();
    f.reply(JSON.stringify({ success: false, error: "boom", result: "partial" }));
    const r = await p;
    assert.equal(r.ok, false);
    assert.match(r.text, /galahad reported failure: boom/);
  });

  it("treats a thrown subscription timeout as a timeout", async () => {
    const f = fakeConn();
    const p = requestKnight({ ...base, conn: f.conn, timeoutMs: 3000 });
    await tick();
    f.fail(new Error("timeout"));
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.text, "Timeout: galahad did not respond within 3s");
  });

  it("reports a failed publish as a publish error and drops the subscription", async () => {
    const f = fakeConn(new Error("timeout"));
    const r = await requestKnight({ ...base, conn: f.conn, timeoutMs: 3000 });
    assert.deepEqual(r, { ok: false, text: "Error publishing task to galahad: timeout" });
    assert.equal(f.wasUnsubscribed(), true);
  });

  it("treats a silently ended subscription as a timeout", async () => {
    const f = fakeConn();
    const p = requestKnight({ ...base, conn: f.conn, timeoutMs: 3000 });
    await tick();
    f.fail(undefined as unknown as Error);
    assert.equal((await p).text, "Timeout: galahad did not respond within 3s");
  });

  it("stops waiting when the signal aborts", async () => {
    const f = fakeConn();
    const ac = new AbortController();
    const p = requestKnight({ ...base, conn: f.conn, timeoutMs: 600_000, signal: ac.signal });
    await tick();
    ac.abort();
    const r = await p;
    assert.equal(r.ok, false);
    assert.equal(r.text, "Request to galahad was cancelled");
    assert.equal(f.wasUnsubscribed(), true);
  });

  it("does not dispatch when already aborted", async () => {
    const f = fakeConn();
    const ac = new AbortController();
    ac.abort();
    const r = await requestKnight({ ...base, conn: f.conn, signal: ac.signal });
    assert.equal(r.text, "Request to galahad was cancelled");
    assert.equal(f.published.length, 0);
  });

  it("fails when NATS is not connected", async () => {
    const r = await requestKnight({ ...base, conn: { nc: null, js: null } });
    assert.deepEqual(r, { ok: false, text: "Error: NATS not connected" });
  });

  it("rejects an empty task", async () => {
    const f = fakeConn();
    const r = await requestKnight({ ...base, task: "  ", conn: f.conn });
    assert.equal(r.ok, false);
    assert.equal(f.published.length, 0);
  });

  it("carries the active trace context in the task headers", async () => {
    const cm = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(cm);
    try {
      const sc = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", traceFlags: TraceFlags.SAMPLED };
      const f = fakeConn();
      const p = context.with(trace.setSpanContext(context.active(), sc), () => requestKnight({ ...base, conn: f.conn }));
      await tick();
      f.reply(JSON.stringify({ success: true, result: "ok" }));
      await p;
      const h = f.published[0]!.headers;
      assert.equal(h?.get("traceparent"), "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    } finally {
      context.disable();
    }
  });

  it("sends no trace headers outside a trace", async () => {
    const f = fakeConn();
    const p = requestKnight({ ...base, conn: f.conn });
    await tick();
    f.reply("{}");
    await p;
    assert.equal(f.published[0]!.headers?.has("traceparent") ?? false, false);
  });
});

describe("publishOutOfBand", () => {
  it("publishes, rejects empty, and reports not connected", async () => {
    const f = fakeConn();
    const ok = await publishOutOfBand("rt-dev.alerts.x", "hi", f.conn);
    assert.deepEqual(ok, { ok: true, text: "Published to rt-dev.alerts.x (2 bytes)" });
    assert.equal(f.published[0]!.payload, "hi");
    assert.equal((await publishOutOfBand("s", " ", f.conn)).ok, false);
    assert.equal((await publishOutOfBand("s", "m", { js: null })).text, "Error: NATS not connected");
  });

  it("reports the size in bytes, not characters", async () => {
    const f = fakeConn();
    const r = await publishOutOfBand("rt-dev.alerts.x", "héllo", f.conn);
    assert.deepEqual(r, { ok: true, text: "Published to rt-dev.alerts.x (6 bytes)" });
  });
});
