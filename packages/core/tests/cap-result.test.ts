// capResultText and the cap inside publishResult (#85).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { capResultText, taskResultErrors, type TaskResult } from "../src/contract/index.ts";
import { publishResult } from "../src/nats/index.ts";

const base: TaskResult = {
  task_id: "t1", knight: "K", success: true, result: "done", duration_ms: 1, cost: 0,
  tokens: { input: 0, output: 0 }, model: "m", timestamp: "2026-11-24T10:00:00.000Z",
};
const withText = (result: string): TaskResult => ({ ...base, result });

describe("capResultText", () => {
  it("leaves a result under the budget unchanged", () => {
    const r = withText("short");
    assert.equal(capResultText(r, 100), r);
    assert.ok(!("result_truncated" in capResultText(r, 100)));
  });

  it("keeps head and tail, adds the marker and fits the budget", () => {
    const text = "HEAD" + "x".repeat(10_000) + "Verdict: ship_it";
    const r = capResultText(withText(text), 1000);
    assert.equal(r.result_truncated, true);
    assert.ok(Buffer.byteLength(r.result) <= 1000);
    assert.ok(r.result.startsWith("HEAD"));
    assert.ok(r.result.endsWith("Verdict: ship_it"));
    assert.match(r.result, /\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n/);
    assert.deepEqual(taskResultErrors(r), []);
  });

  it("never cuts inside a multi-byte character", () => {
    for (let budget = 100; budget < 112; budget++) {
      const r = capResultText(withText("é€😀".repeat(200)), budget);
      assert.ok(!r.result.includes("�"), `budget ${budget}`);
      assert.ok(Buffer.byteLength(r.result) <= budget);
    }
  });
});

describe("publishResult cap", () => {
  function capture() {
    const sent: string[] = [];
    return { sent, js: { publish: (async (_s: string, p: string) => { sent.push(p); return { seq: 1 }; }) as never } };
  }

  it("publishes a 3 MB result under the budget, marked truncated", async () => {
    const c = capture();
    await publishResult("t1", withText("a".repeat(3 * 1024 * 1024)), { js: c.js, resultMaxBytes: 512 * 1024, maxPayload: 1024 * 1024 });
    const out = JSON.parse(c.sent[0]!) as TaskResult;
    assert.equal(out.result_truncated, true);
    assert.ok(c.sent[0]!.length < 1024 * 1024);
    assert.ok(Buffer.byteLength(out.result) <= 512 * 1024);
  });

  it("uses a smaller max_payload", async () => {
    const c = capture();
    await publishResult("t1", withText("a".repeat(100_000)), { js: c.js, resultMaxBytes: 512 * 1024, maxPayload: 20_000 });
    assert.ok(Buffer.byteLength(c.sent[0]!) <= 20_000);
  });

  it("publishes a small result byte for byte", async () => {
    const c = capture();
    const r = withText("fine");
    await publishResult("t1", r, { js: c.js, maxPayload: 1024 * 1024 });
    assert.equal(c.sent[0], JSON.stringify(r));
  });
});
