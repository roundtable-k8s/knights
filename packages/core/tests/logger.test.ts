import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { initLogger, log, setLogStream } from "../src/logger.js";

function capture(): { lines: () => Record<string, unknown>[]; stream: Writable } {
  const chunks: string[] = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
  return { stream, lines: () => chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

test("logger writes JSON lines to the configured stream with the knight name", () => {
  const cap = capture();
  setLogStream(cap.stream);
  initLogger("galahad", "info");
  log.info("hello", { a: 1 });
  const [e] = cap.lines();
  assert.equal(e!["level"], "info");
  assert.equal(e!["msg"], "hello");
  assert.equal(e!["knight"], "galahad");
  assert.equal(e!["a"], 1);
});

test("logger filters below the min level and falls back to info on unknown levels", () => {
  const cap = capture();
  setLogStream(cap.stream);
  initLogger("k", "warn");
  log.info("no");
  log.warn("yes");
  assert.deepEqual(cap.lines().map((l) => l["msg"]), ["yes"]);
  initLogger("k", "bogus");
  log.debug("no");
  log.info("yes2");
  assert.deepEqual(cap.lines().map((l) => l["msg"]), ["yes", "yes2"]);
});
