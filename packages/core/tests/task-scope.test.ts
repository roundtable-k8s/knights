import { strict as assert } from "node:assert";
import { test, mock } from "node:test";
import { startTaskScope } from "../src/task-scope.ts";

function setup(extra: Partial<Parameters<typeof startTaskScope>[0]> = {}) {
  mock.timers.reset();
  mock.timers.enable({ apis: ["setInterval", "setTimeout"] });
  const calls: string[] = [];
  const scope = startTaskScope({
    delivery: { working: () => calls.push("working"), ack: () => calls.push("ack") },
    timeoutMs: 1000,
    heartbeatMs: 100,
    onHeartbeat: () => calls.push("beat"),
    onOpen: () => calls.push("open"),
    onClose: () => calls.push("close"),
    ...extra,
  });
  return { scope, calls };
}

test("heartbeat fires at the interval and stops after close", () => {
  const { scope, calls } = setup();
  mock.timers.tick(250);
  assert.deepEqual(calls, ["open", "working", "beat", "working", "beat"]);
  scope.close();
  calls.length = 0;
  mock.timers.tick(500);
  assert.deepEqual(calls, []);
  mock.timers.reset();
});

test("timeout aborts the signal and sets timedOut; abort() does not", () => {
  const a = setup();
  assert.equal(a.scope.timedOut, false);
  mock.timers.tick(1000);
  assert.equal(a.scope.signal.aborted, true);
  assert.equal(a.scope.timedOut, true);
  a.scope.close();
  const b = setup();
  b.scope.abort();
  assert.equal(b.scope.signal.aborted, true);
  assert.equal(b.scope.timedOut, false);
  b.scope.close();
  mock.timers.reset();
});

test("close twice acks once, onClose runs before ack", () => {
  const { scope, calls } = setup();
  scope.close();
  scope.close();
  assert.deepEqual(calls, ["open", "close", "ack"]);
  mock.timers.reset();
});

test("close clears the timeout", () => {
  const { scope } = setup();
  scope.close();
  mock.timers.tick(5000);
  assert.equal(scope.signal.aborted, false);
  mock.timers.reset();
});

test("a throwing onHeartbeat does not stop later beats", () => {
  let n = 0;
  const { scope, calls } = setup({
    onHeartbeat: () => {
      n++;
      throw new Error("boom");
    },
  });
  mock.timers.tick(300);
  assert.equal(n, 3);
  assert.equal(calls.filter((c) => c === "working").length, 3);
  scope.close();
  mock.timers.reset();
});

test("a throwing onClose still acks", () => {
  const { scope, calls } = setup({ onClose: () => { throw new Error("x"); } });
  scope.close();
  assert.equal(calls.at(-1), "ack");
  mock.timers.reset();
});
