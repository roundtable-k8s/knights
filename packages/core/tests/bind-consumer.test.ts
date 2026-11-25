import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { bindConsumer } from "../src/nats/index.ts";

const desired = { durable_name: "k-consumer", max_deliver: 1 };
const notFound = () => Object.assign(new Error("consumer not found"), { code: "404" });

function fake(infoImpl: (n: number) => Promise<unknown>) {
  const calls = { info: 0, add: 0, del: 0, update: 0 };
  return {
    calls,
    jsm: {
      consumers: {
        info: async () => infoImpl(++calls.info),
        add: async () => { calls.add++; return {}; },
        delete: async () => { calls.del++; },
        update: async () => { calls.update++; },
      },
    },
  };
}

describe("bindConsumer", () => {
  it("binds to an existing consumer without changing it", async () => {
    const f = fake(async () => ({ config: { max_deliver: 5, deliver_policy: "new" } }));
    assert.equal(await bindConsumer(f.jsm, "S", desired), "bound");
    assert.deepEqual(f.calls, { info: 1, add: 0, del: 0, update: 0 });
  });

  it("waits with backoff, then binds when the consumer appears", async () => {
    const f = fake(async (n) => { if (n < 3) throw notFound(); return {}; });
    const sleeps: number[] = [];
    const r = await bindConsumer(f.jsm, "S", desired, { sleep: async (ms) => { sleeps.push(ms); } });
    assert.equal(r, "bound");
    assert.equal(f.calls.add, 0);
    assert.deepEqual(sleeps, [1000, 2000]);
  });

  it("creates the consumer after the wait window expires", async () => {
    const f = fake(async () => { throw notFound(); });
    let t = 0;
    const r = await bindConsumer(f.jsm, "S", desired, {
      waitMs: 5000, now: () => t, sleep: async (ms) => { t += ms; },
    });
    assert.equal(r, "created");
    assert.equal(f.calls.add, 1);
    assert.ok(f.calls.info >= 2);
  });

  it("rethrows non-not-found errors", async () => {
    const f = fake(async () => { throw Object.assign(new Error("permissions violation"), { code: "403" }); });
    await assert.rejects(bindConsumer(f.jsm, "S", desired, { sleep: async () => {} }), /permissions/);
    assert.equal(f.calls.add, 0);
  });
});
