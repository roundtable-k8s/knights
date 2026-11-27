import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createActiveCounter } from "../src/active-count.ts";

test("increment and decrement report the new count and update get()", () => {
  const seen: number[] = [];
  const counter = createActiveCounter((n) => seen.push(n));
  assert.equal(counter.get(), 0);
  counter.increment();
  counter.increment();
  counter.decrement();
  assert.equal(counter.get(), 1);
  assert.deepEqual(seen, [1, 2, 1]);
});

test("a throwing change hook still leaves get() equal to the real count", () => {
  let fail = false;
  const counter = createActiveCounter(() => {
    if (fail) throw new Error("setter down");
  });
  counter.increment();
  assert.equal(counter.get(), 1);

  fail = true;
  assert.throws(() => counter.increment(), /setter down/);
  assert.equal(counter.get(), 2, "the task opened, so it is counted");

  assert.throws(() => counter.decrement(), /setter down/);
  assert.equal(counter.get(), 1, "the task closed, so it is no longer counted");

  fail = false;
  counter.decrement();
  assert.equal(counter.get(), 0);
});
