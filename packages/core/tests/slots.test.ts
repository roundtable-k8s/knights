import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SlotPool, withSlot, isSelfEcho, runInSlot } from "../src/slots.ts";
import type { TaskDelivery } from "../src/nats/index.ts";

test("acquire returns the lowest free slot", () => {
  const p = new SlotPool();
  assert.deepEqual([p.acquire(), p.acquire(), p.acquire()], [0, 1, 2]);
  assert.equal(p.inUse(), 3);
});

test("a released slot is reused before a higher one", () => {
  const p = new SlotPool();
  p.acquire();
  p.acquire();
  p.acquire();
  p.release(1);
  assert.equal(p.inUse(), 2);
  assert.equal(p.acquire(), 1);
  assert.equal(p.acquire(), 3);
});

test("double release is harmless", () => {
  const p = new SlotPool();
  const a = p.acquire();
  const b = p.acquire();
  p.release(a);
  p.release(a);
  p.release(99);
  assert.equal(p.inUse(), 1);
  assert.equal(p.acquire(), a);
  assert.notEqual(p.acquire(), b);
});

test("withSlot frees the slot when fn throws, and passes the slot to fn", async () => {
  const p = new SlotPool();
  assert.equal(await withSlot(p, async (slot) => slot), 0);
  assert.equal(p.inUse(), 0);
  await assert.rejects(
    withSlot(p, async () => {
      assert.equal(p.inUse(), 1);
      throw new Error("activity constructor failed");
    }),
    /activity constructor failed/,
  );
  assert.equal(p.inUse(), 0);
});

test("isSelfEcho matches case-insensitively and never on empty from", () => {
  assert.equal(isSelfEcho({ taskId: "t", from: "Lancelot" }, "lancelot"), true);
  assert.equal(isSelfEcho({ taskId: "t", from: "gawain" }, "lancelot"), false);
  assert.equal(isSelfEcho({ taskId: "t", from: "" }, "lancelot"), false);
  assert.equal(isSelfEcho({ taskId: "t" }, ""), false);
});

test("runInSlot acks the delivery and frees the slot when the handler throws", async () => {
  const slots = new SlotPool();
  let acked = 0;
  const delivery = { task: { taskId: "t" }, ack: () => { acked++; } } as unknown as TaskDelivery;
  runInSlot(slots, delivery, async () => { throw new Error("boom"); });
  assert.equal(slots.inUse(), 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(acked, 1);
  assert.equal(slots.inUse(), 0);
});

test("runInSlot does not ack when the handler succeeds", async () => {
  const slots = new SlotPool();
  let acked = 0;
  const delivery = { task: { taskId: "t" }, ack: () => { acked++; } } as unknown as TaskDelivery;
  runInSlot(slots, delivery, async (_d, slot) => { assert.equal(slot, 0); });
  await new Promise((r) => setImmediate(r));
  assert.equal(acked, 0);
  assert.equal(slots.inUse(), 0);
});
