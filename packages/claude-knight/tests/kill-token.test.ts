/**
 * The final SIGKILL repeats its scan until a pass finds nothing. These tests
 * inject the scanner and the signal sender, so no real process is touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { killByToken, killByTokenUntilEmpty } from "../src/cli-runner.js";

function scripted(passes: number[][]) {
  let i = 0;
  const calls: string[] = [];
  const scan = (token: string) => {
    calls.push(token);
    return passes[Math.min(i++, passes.length - 1)] ?? [];
  };
  return { scan, calls };
}

test("SIGKILL repeats the scan until a pass finds nothing (a late fork is caught)", async () => {
  // First scan finds pid 101, the second finds a child forked in between, the third is empty.
  const { scan, calls } = scripted([[101], [202], []]);
  const sent: Array<[number, string]> = [];
  const total = await killByTokenUntilEmpty("tok", scan, (pid, sig) => sent.push([pid, sig]), 5, 0);
  assert.equal(total, 2);
  assert.deepEqual(sent, [[101, "SIGKILL"], [202, "SIGKILL"]]);
  assert.equal(calls.length, 3, "stops on the first empty pass");
});

test("SIGKILL stops after the pass bound even if something keeps reappearing", async () => {
  const { scan, calls } = scripted([[7]]);
  const sent: Array<[number, string]> = [];
  const total = await killByTokenUntilEmpty("tok", scan, (pid, sig) => sent.push([pid, sig]), 5, 0);
  assert.equal(calls.length, 5);
  assert.equal(total, 5);
  assert.equal(sent.length, 5);
});

test("SIGKILL with nothing running makes one scan and sends nothing", async () => {
  const { scan, calls } = scripted([[]]);
  let sends = 0;
  assert.equal(await killByTokenUntilEmpty("tok", scan, () => sends++, 5, 0), 0);
  assert.equal(calls.length, 1);
  assert.equal(sends, 0);
});

test("killByToken signals each scanned pid and tolerates ones already gone", () => {
  const sent: number[] = [];
  const n = killByToken(
    "tok",
    "SIGTERM",
    () => [1, 2, 3],
    (pid) => {
      if (pid === 2) throw new Error("ESRCH");
      sent.push(pid);
    },
  );
  assert.equal(n, 3);
  assert.deepEqual(sent, [1, 3]);
});
