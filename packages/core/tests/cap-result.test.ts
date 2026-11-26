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

  for (const [name, unit] of [["newline", "\n"], ["quote", '"'], ["backslash", "\\"], ["control-char", "\u001b"], ["mixed", 'x\n"\u001b[0m\\']] as const) {
    it(`fits max_payload with ${name}-heavy text`, async () => {
      const c = capture();
      await publishResult("t1", withText(unit.repeat(100_000)), { js: c.js, resultMaxBytes: 512 * 1024, maxPayload: 20_000 });
      assert.ok(Buffer.byteLength(c.sent[0]!) <= 20_000, `${name}: ${Buffer.byteLength(c.sent[0]!)}`);
      assert.equal((JSON.parse(c.sent[0]!) as TaskResult).result_truncated, true);
    });
  }

  it("keeps proportional text when newlines double the payload", async () => {
    const c = capture();
    await publishResult("t1", withText("\n".repeat(100_000)), { js: c.js, resultMaxBytes: 512 * 1024, maxPayload: 20_000 });
    assert.ok(Buffer.byteLength(c.sent[0]!) <= 20_000);
    assert.ok(Buffer.byteLength((JSON.parse(c.sent[0]!) as TaskResult).result) > 8_000);
  });

  it("keeps proportional text when control characters expand sixfold", async () => {
    const c = capture();
    await publishResult("t1", withText("\u001b".repeat(100_000)), { js: c.js, resultMaxBytes: 512 * 1024, maxPayload: 20_000 });
    assert.ok(Buffer.byteLength(c.sent[0]!) <= 20_000);
    assert.ok(Buffer.byteLength((JSON.parse(c.sent[0]!) as TaskResult).result) > 2_500);
  });

  for (const [name, unit] of [["newline", "\n"], ["quote", '"'], ["backslash", "\\"], ["control-char", "\u001b"], ["mixed", 'x\n"\u001b[0m\\']] as const) {
    it(`keeps at least 70 % of the text the escaping ratio allows for ${name}-heavy text`, async () => {
      const c = capture();
      await publishResult("t1", withText(unit.repeat(100_000)), { js: c.js, resultMaxBytes: 512 * 1024, maxPayload: 20_000 });
      const kept = Buffer.byteLength((JSON.parse(c.sent[0]!) as TaskResult).result);
      const ratio = Buffer.byteLength(JSON.stringify(unit).slice(1, -1)) / Buffer.byteLength(unit);
      const allowed = (20_000 - 1_000) / ratio;
      assert.ok(kept >= 0.7 * allowed, `${name}: kept ${kept}, allowed ${allowed.toFixed(0)}`);
    });
  }

  it("capResultText stays within a budget smaller than the marker", () => {
    const out = capResultText(withText("é".repeat(100)), 10);
    assert.ok(Buffer.byteLength(out.result) <= 10);
    assert.equal(out.result_truncated, true);
  });

  it("publishes a small result byte for byte", async () => {
    const c = capture();
    const r = withText("fine");
    await publishResult("t1", r, { js: c.js, maxPayload: 1024 * 1024 });
    assert.equal(c.sent[0], JSON.stringify(r));
  });
});
