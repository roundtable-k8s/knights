import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { applyStatus, connectionStateFor, findResult, TaskTracker, watchLostTasks } from "../src/nats/index.ts";

describe("connectionStateFor (#149)", () => {
  it("error and unknown statuses leave the state unchanged", () => {
    assert.equal(connectionStateFor("error", true), true);
    assert.equal(connectionStateFor("error", false), false);
    assert.equal(connectionStateFor("ldm", true), true);
  });
  it("disconnect and close mark down, reconnect marks up", () => {
    assert.equal(connectionStateFor("disconnect", true), false);
    assert.equal(connectionStateFor("close", true), false);
    assert.equal(connectionStateFor("reconnect", false), true);
  });
});

describe("applyStatus (#247)", () => {
  it("an error status keeps the state and never calls onStatus", () => {
    const seen: boolean[] = [];
    const onStatus = (c: boolean) => seen.push(c);
    assert.equal(applyStatus(true, { type: "error", error: new Error("permissions violation") }, onStatus), true);
    assert.equal(applyStatus(false, { type: "error" }, onStatus), false);
    assert.deepEqual(seen, []);
  });
  it("disconnect calls onStatus(false) once; a repeated disconnect does not call it again", () => {
    const seen: boolean[] = [];
    const onStatus = (c: boolean) => seen.push(c);
    const s1 = applyStatus(true, { type: "disconnect" }, onStatus);
    const s2 = applyStatus(s1, { type: "close" }, onStatus);
    assert.equal(s2, false);
    assert.deepEqual(seen, [false]);
  });
  it("reconnect calls onStatus(true) once", () => {
    const seen: boolean[] = [];
    assert.equal(applyStatus(false, { type: "reconnect" }, (c) => seen.push(c)), true);
    assert.deepEqual(seen, [true]);
  });
  it("unrelated statuses do not call onStatus", () => {
    const seen: boolean[] = [];
    assert.equal(applyStatus(true, { type: "ldm" }, (c) => seen.push(c)), true);
    assert.deepEqual(seen, []);
  });
  it("works without an onStatus callback", () => {
    assert.equal(applyStatus(true, { type: "disconnect" }), false);
  });
});

describe("watchLostTasks: the stream message is gone (#247)", () => {
  /** A connection whose lost-task advisory subscription yields the given messages, then ends. */
  function advisoryConn(advisories: unknown[]) {
    const sub = {
      async *[Symbol.asyncIterator]() {
        for (const m of advisories) yield m;
      },
      unsubscribe() {},
    };
    return { subscribe: () => sub } as never;
  }
  const advisory = { json: () => ({ stream_seq: 7 }) };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function run(getMessage: () => Promise<unknown>) {
    const getCalls: unknown[] = [];
    const lost: unknown[] = [];
    const jsm = {
      streams: {
        getMessage: async (...args: unknown[]) => {
          getCalls.push(args);
          return getMessage();
        },
        find: async () => {
          throw new Error("find must not run for a task that is not in the stream");
        },
      },
    } as never;
    const stop = watchLostTasks(advisoryConn([advisory]), jsm, {
      stream: "TASKS",
      durable: "k-consumer",
      resultsPrefix: "res",
      tracker: new TaskTracker(),
      onLost: (task) => {
        lost.push(task);
      },
    });
    for (let i = 0; i < 100 && getCalls.length === 0; i++) await sleep(5);
    await sleep(20); // let the handler finish after getMessage resolves
    stop();
    assert.deepEqual(getCalls, [["TASKS", { seq: 7 }]]);
    return lost;
  }

  it("a null getMessage result reports nothing lost", async () => {
    assert.deepEqual(await run(async () => null), []);
  });
  it("a rejected getMessage reports nothing lost and does not stop the watcher", async () => {
    assert.deepEqual(await run(async () => Promise.reject(new Error("stream unavailable"))), []);
  });
});

describe("findResult timeout (#149)", () => {
  it("returns undefined quickly when the stream calls hang", async () => {
    const never = new Promise<never>(() => {});
    const jsm = { streams: { find: () => never, getMessage: () => never } } as never;
    const t0 = Date.now();
    assert.equal(await findResult(jsm, "res", "t1", 50), undefined);
    assert.ok(Date.now() - t0 < 1000);
  });
  it("returns the stored result when the calls answer", async () => {
    const jsm = { streams: { find: async () => "S", getMessage: async () => ({ json: () => ({ success: true }) }) } } as never;
    assert.deepEqual(await findResult(jsm, "res", "t1"), { success: true });
  });
});
