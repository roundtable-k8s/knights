import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runBrowser, setBrowserExec, browserEnabled, BROWSER_MAX_OUTPUT } from "../src/browser.js";

const calls: Array<{ bin: string; args: string[] }> = [];
afterEach(() => {
  setBrowserExec(null);
  delete process.env.BROWSER_CDP_URL;
  delete process.env.AGENT_BROWSER_BIN;
});

const hostile = [`"; touch /tmp/x; "`, "$(id)", "`id`", "a b' && id"];

test("hostile strings reach exec as single untouched argv elements", async () => {
  calls.length = 0;
  setBrowserExec(async (bin, args) => {
    calls.push({ bin, args });
    return "ok";
  });
  for (const h of hostile) {
    await runBrowser(["fill", h, h]);
    assert.deepEqual(calls.at(-1)!.args, ["fill", h, h]);
  }
});

test("connect runs first and its failure is ignored", async () => {
  calls.length = 0;
  process.env.BROWSER_CDP_URL = "http://cdp:1";
  process.env.AGENT_BROWSER_BIN = "/bin/ab";
  setBrowserExec(async (bin, args) => {
    calls.push({ bin, args });
    if (args[0] === "connect") throw new Error("down");
    return "done";
  });
  assert.equal(await runBrowser(["snapshot"]), "done");
  assert.deepEqual(calls[0], { bin: "/bin/ab", args: ["connect", "http://cdp:1"] });
  assert.deepEqual(calls[1], { bin: "/bin/ab", args: ["snapshot"] });
});

test("a failing command rejects", async () => {
  setBrowserExec(async (_b, args) => {
    if (args[0] === "open") throw new Error("boom");
    return "";
  });
  await assert.rejects(runBrowser(["open", "x"]), /boom/);
});

test("output over the cap is truncated with a note", async () => {
  setBrowserExec(async (_b, args) => (args[0] === "connect" ? "" : "x".repeat(BROWSER_MAX_OUTPUT + 50)));
  const out = await runBrowser(["snapshot"]);
  assert.ok(out.startsWith("x".repeat(BROWSER_MAX_OUTPUT)));
  assert.match(out, /\[truncated 50 chars\]$/);
});

test("browserEnabled reads BROWSER_ENABLED", () => {
  assert.equal(browserEnabled({ BROWSER_ENABLED: "true" }), true);
  assert.equal(browserEnabled({}), false);
});
