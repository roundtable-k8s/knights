import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { initLogger } from "../src/logger.js";
import { captureLogs } from "./helpers/log-capture.js";
import { installProcessErrorHandlers } from "../src/process-errors.js";
import { TaskActivity } from "../src/activity.js";

function setup() {
  const logs = captureLogs();
  initLogger("k", "info");
  const target = new EventEmitter();
  const codes: number[] = [];
  installProcessErrorHandlers({ target: target as unknown as NodeJS.Process, exit: (c) => codes.push(c) });
  const lines = () => logs.lines();
  return { target, codes, lines };
}

test("unhandled rejection logs structured error with in-flight task ids and exits 1 once", () => {
  const a = new TaskActivity({
    knight: "k", prefix: "rt", taskId: "task-206-a", identity: { pod: "p", node: "n" },
    runId: "r", model: "m", publish: () => {},
  });
  a.started();
  const { target, codes, lines } = setup();
  try {
    target.emit("unhandledRejection", new Error("boom"));
    target.emit("uncaughtException", new Error("second"));
  } finally {
    a.close();
  }
  assert.deepEqual(codes, [1]);
  const l = lines();
  assert.equal(l.length, 1);
  assert.equal(l[0]!["level"], "error");
  assert.equal(l[0]!["msg"], "Unhandled promise rejection");
  assert.equal(l[0]!["error"], "boom");
  assert.equal(typeof l[0]!["stack"], "string");
  assert.ok((l[0]!["inflight"] as string[]).includes("task-206-a"));
});

test("uncaught exception logs structured error and exits 1", () => {
  const { target, codes, lines } = setup();
  target.emit("uncaughtException", "not an error");
  assert.deepEqual(codes, [1]);
  assert.equal(lines()[0]!["msg"], "Uncaught exception");
  assert.equal(lines()[0]!["error"], "not an error");
});
