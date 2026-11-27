// trackDelivery: the ack wrapper subscribe() puts around each delivery (the `acked` guard, tracker lifecycle).
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { trackDelivery, type TaskDelivery } from "../src/nats/index.ts";

function stubTracker() {
  const calls: string[] = [];
  return {
    calls,
    tracker: {
      started: (id: string) => { calls.push(`started:${id}`); },
      touch: (id: string) => { calls.push(`touch:${id}`); },
      finished: (id: string) => { calls.push(`finished:${id}`); },
    },
  };
}

function stubDelivery() {
  let wireAcks = 0;
  let wireWorking = 0;
  const d = {
    task: { taskId: "t1" },
    working: () => { wireWorking++; },
    ack: () => { wireAcks++; },
  } as unknown as TaskDelivery;
  return { d, wire: () => ({ acks: wireAcks, working: wireWorking }) };
}

test("trackDelivery starts the tracker for the task on wrap", () => {
  const { calls, tracker } = stubTracker();
  trackDelivery(tracker, stubDelivery().d);
  assert.deepEqual(calls, ["started:t1"]);
});

test("trackDelivery forwards a heartbeat to the tracker and the wire", () => {
  const { calls, tracker } = stubTracker();
  const s = stubDelivery();
  const wrapped = trackDelivery(tracker, s.d);
  wrapped.working();
  wrapped.working();
  assert.deepEqual(calls, ["started:t1", "touch:t1", "touch:t1"]);
  assert.deepEqual(s.wire(), { acks: 0, working: 2 });
});

test("trackDelivery's first ack finishes the task and acks the wire once", () => {
  const { calls, tracker } = stubTracker();
  const s = stubDelivery();
  trackDelivery(tracker, s.d).ack();
  assert.deepEqual(calls, ["started:t1", "finished:t1"]);
  assert.deepEqual(s.wire(), { acks: 1, working: 0 });
});

test("trackDelivery: a double ack() calls tracker.finished and the wire ack once", () => {
  const { calls, tracker } = stubTracker();
  const s = stubDelivery();
  const wrapped = trackDelivery(tracker, s.d);
  wrapped.ack();
  wrapped.ack();
  assert.deepEqual(calls.filter((c) => c.startsWith("finished")), ["finished:t1"]);
  assert.deepEqual(s.wire(), { acks: 1, working: 0 });
});

test("trackDelivery: working() after ack still reaches the tracker only as a touch (no second finish)", () => {
  const { calls, tracker } = stubTracker();
  const wrapped = trackDelivery(tracker, stubDelivery().d);
  wrapped.ack();
  wrapped.working();
  assert.equal(calls.filter((c) => c === "finished:t1").length, 1);
  assert.equal(calls.filter((c) => c === "touch:t1").length, 1);
});

test("trackDelivery keeps the rest of the delivery (task, trace context)", () => {
  const { tracker } = stubTracker();
  const traceContext = { traceparent: "00-abc-def-01" };
  const d = { task: { taskId: "t9" }, traceContext, working: () => {}, ack: () => {} } as unknown as TaskDelivery;
  const wrapped = trackDelivery(tracker, d);
  assert.equal(wrapped.task, d.task);
  assert.equal(wrapped.traceContext, traceContext);
});
