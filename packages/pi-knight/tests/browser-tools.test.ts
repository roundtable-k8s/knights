import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setBrowserExec } from "@roundtable/knight-core";
import { browserTools } from "../src/tools/browser.js";

const byName = (n: string) => browserTools.find((t) => t.name === n)!;
const run = (n: string, p: any): Promise<any> => (byName(n).execute as any)("id", p);
const calls: string[][] = [];
const nasty = `"; touch /tmp/x; $(id) \`id\``;

function fake(out = "") {
  calls.length = 0;
  setBrowserExec(async (_b, args) => {
    calls.push(args);
    return out;
  });
}

afterEach(() => {
  setBrowserExec(null);
  delete process.env.BROWSER_ENABLED;
  delete process.env.BROWSER_CDP_URL;
});

test("every tool says the capability is off when BROWSER_ENABLED is unset", async () => {
  fake();
  const params: Record<string, any> = {
    browser_open: { url: "u" }, browser_click: { ref: "r" }, browser_fill: { ref: "r", text: "t" },
    browser_get_text: { ref: "r" }, browser_eval: { js: "1" },
  };
  for (const t of browserTools) {
    const r = await run(t.name, params[t.name] ?? {});
    assert.match(r.content[0].text, /Browser capability not enabled/);
  }
  assert.equal(calls.length, 0);
});

test("tools pass argv arrays, hostile text stays one element", async () => {
  process.env.BROWSER_ENABLED = "true";
  process.env.BROWSER_CDP_URL = "http://cdp:9";
  fake("out");
  await run("browser_open", { url: nasty });
  assert.deepEqual(calls[0], ["connect", "http://cdp:9"]);
  assert.deepEqual(calls[1], ["open", nasty]);
  await run("browser_click", { ref: nasty });
  assert.deepEqual(calls.at(-1), ["click", nasty]);
  await run("browser_fill", { ref: nasty, text: nasty });
  assert.deepEqual(calls.at(-1), ["fill", nasty, nasty]);
  await run("browser_get_text", { ref: nasty });
  assert.deepEqual(calls.at(-1), ["get", "text", nasty]);
  await run("browser_screenshot", { full: true, path: nasty });
  assert.deepEqual(calls.at(-1), ["screenshot", "--full", nasty]);
  await run("browser_screenshot", {});
  assert.deepEqual(calls.at(-1), ["screenshot"]);
  await run("browser_eval", { js: nasty });
  assert.deepEqual(calls.at(-1), ["eval", "-b", Buffer.from(nasty).toString("base64")]);
  await run("browser_snapshot", {});
  assert.deepEqual(calls.at(-1), ["snapshot"]);
  await run("browser_close", {});
  assert.deepEqual(calls.at(-1), ["close"]);
});

test("empty output keeps the default messages", async () => {
  process.env.BROWSER_ENABLED = "true";
  fake("");
  assert.equal((await run("browser_open", { url: "http://a" })).content[0].text, "Navigated to http://a");
  assert.equal((await run("browser_close", {})).content[0].text, "Browser closed");
});

test("a failing command rejects so the SDK records a tool error", async () => {
  process.env.BROWSER_ENABLED = "true";
  setBrowserExec(async (_b, a) => { if (a[0] === "connect") return ""; throw new Error("bad"); });
  await assert.rejects(run("browser_close", {}), /bad/);
  await assert.rejects(run("browser_click", { ref: "@e1" }), /bad/);
});

test("an unreachable sidecar is named in the rejection", async () => {
  process.env.BROWSER_ENABLED = "true";
  process.env.BROWSER_CDP_URL = "http://cdp:9";
  setBrowserExec(async (_b, a) => { if (a[0] === "connect") throw new Error("refused"); throw new Error("no daemon"); });
  await assert.rejects(run("browser_snapshot", {}), /could not connect to the browser at http:\/\/cdp:9; is the browser sidecar running\?\)$/);
});
