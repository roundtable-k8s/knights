import { strict as assert } from "node:assert";
import { test } from "node:test";
import { SlotPool } from "../src/slots.ts";

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
