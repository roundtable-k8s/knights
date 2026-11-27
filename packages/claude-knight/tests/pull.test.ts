// Runtime-level check that the core pull loop hands this runtime's tasks to its handler.
// The loop itself (slots, nak on stop, real nats-server) is tested in packages/core.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { startPullLoop, type PulledMsg, type TaskDelivery } from "@roundtable/knight-core";

const fixture = (name: string) =>
  readFileSync(new URL(`../../core/tests/fixtures/${name}.json`, import.meta.url), "utf8").trim();

test("a claude-knight task flows from the core pull loop into the handler, un-acked until done", async () => {
  const calls: string[] = [];
  const msg = (body: string, id: string): PulledMsg => ({
    data: new TextEncoder().encode(body),
    subject: `fleet-a.tasks.claude-knight.${id}`,
    ack: () => calls.push(`ack:${id}`),
    working: () => calls.push(`working:${id}`),
    term: () => calls.push(`term:${id}`),
  });
  const knightName = "Tester";
  let served = false;
  const handled: TaskDelivery[] = [];
  const puller = startPullLoop({
    freeSlots: () => 2 - handled.length,
    fetch: async () => {
      const batch = served ? [] : [
        msg(fixture("claude-knight-task"), "own"),
        msg(fixture("operator-task"), "op"),
        msg(JSON.stringify({ task: "echo", from: "tester" }), "self"),
      ];
      served = true;
      if (!batch.length) await new Promise((r) => setTimeout(r, 20));
      return (async function* () { yield* batch; })();
    },
    // Same self-echo rule the runtime's subscribe() uses.
    accept: (t) => !(t.from && t.from.toLowerCase() === knightName.toLowerCase()),
    onTask: (d) => handled.push(d),
  });
  const end = Date.now() + 5000;
  while (calls.length === 0 || handled.length < 2) {
    if (Date.now() > end) throw new Error("timed out waiting for tasks");
    await new Promise((r) => setTimeout(r, 10));
  }
  await puller.stop();

  const own = JSON.parse(fixture("claude-knight-task"));
  assert.equal(handled[0]!.task.taskId, own.task_id);
  assert.equal(handled[0]!.task.task, own.task);
  assert.equal(handled[0]!.task.dispatchedBy, own.dispatched_by);
  assert.deepEqual(
    [handled[1]!.task.runId, handled[1]!.task.chainName, handled[1]!.task.stepName, handled[1]!.task.model],
    ["5f0c2a8e-1d3b-4c55-9a77-0b6d2a9e4f11", "issue-to-pr", "implement", "claude-opus-5-5"],
  );
  assert.deepEqual(calls, ["ack:self"], "self-echo acked and dropped; handled tasks stay un-acked");
  handled[0]!.working();
  handled[0]!.ack();
  assert.deepEqual(calls.slice(1), ["working:own", "ack:own"]);
});
