import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setBrowserExec } from "@roundtable/knight-core";
import { browserTools, BROWSER_TOOL_IDS } from "../src/browser.js";
import { roundtableToolIds } from "../src/tools.js";
import { buildPreamble } from "../src/prompt.js";
import { loadConfig } from "../src/config.js";

// The argument shape of each browser tool, so a wrong shape or an unknown name fails typecheck.
type BrowserArgs = {
  browser_open: { url: string };
  browser_snapshot: Record<string, never>;
  browser_click: { ref: string };
  browser_fill: { ref: string; text: string };
  browser_get_text: { ref: string };
  browser_screenshot: { path?: string; full?: boolean };
  browser_eval: { js: string };
  browser_close: Record<string, never>;
};
// Calls the named tool's handler with that tool's own arguments.
function call<N extends keyof BrowserArgs>(name: N, args: BrowserArgs[N]): Promise<any> {
  const tool = browserTools.find((t) => t.name === name)!;
  return (tool.handler as unknown as (a: BrowserArgs[N], extra: unknown) => Promise<any>)(args, {});
}
const calls: string[][] = [];

function fakeExec(outputs: Record<string, string> = {}) {
  calls.length = 0;
  setBrowserExec(async (_bin, args) => {
    calls.push(args);
    if (args[0] === "screenshot") {
      writeFileSync(args[args.length - 1]!, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return "";
    }
    return outputs[args[0]!] ?? "";
  });
}

afterEach(() => {
  setBrowserExec(null);
  delete process.env.BROWSER_ENABLED;
});

test("browser tools refuse when the capability is off", async () => {
  fakeExec();
  const r = await call("browser_open", { url: "https://example.com" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /spec\.capabilities\.browser/);
  assert.equal(calls.length, 0);
  assert.deepEqual(roundtableToolIds(), ["mcp__roundtable__nats_publish", "mcp__roundtable__nats_request", "mcp__roundtable__find_knights"]);
});

test("arguments go to agent-browser as argv, never through a shell", async () => {
  process.env.BROWSER_ENABLED = "true";
  fakeExec({ snapshot: "- button \"Sign in\" [ref=e2]" });
  await call("browser_open", { url: "https://x.test/?q=a b" });
  assert.deepEqual(calls[0], ["connect", "http://localhost:9222"]);
  assert.deepEqual(calls[1], ["open", "https://x.test/?q=a b"]);

  const nasty = `"; rm -rf ~; echo "`;
  await call("browser_fill", { ref: "@e3", text: nasty });
  assert.deepEqual(calls.at(-1), ["fill", "@e3", nasty]);

  const snap = await call("browser_snapshot", {});
  assert.match(snap.content[0].text, /Sign in/);

  await call("browser_eval", { js: "document.title" });
  assert.deepEqual(calls.at(-1), ["eval", "-b", Buffer.from("document.title").toString("base64")]);
});

test("screenshots come back as an image", async () => {
  process.env.BROWSER_ENABLED = "true";
  fakeExec();
  const path = join(mkdtempSync(join(tmpdir(), "ck-shot-")), "shot.png");
  const r = await call("browser_screenshot", { path, full: true });
  assert.deepEqual(calls.at(-1), ["screenshot", "--full", path]);
  assert.equal(r.content[0].type, "image");
  assert.equal(r.content[0].mimeType, "image/png");
  assert.equal(Buffer.from(r.content[0].data, "base64")[1], 0x50);
});

test("errors are returned to the model, not thrown", async () => {
  process.env.BROWSER_ENABLED = "true";
  setBrowserExec(async (_b, args) => {
    if (args[0] === "connect") return "";
    throw new Error("net::ERR_NAME_NOT_RESOLVED");
  });
  const r = await call("browser_open", { url: "https://nope.invalid" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /ERR_NAME_NOT_RESOLVED/);
});

test("enabled browser adds tool ids and prompt guidance", () => {
  process.env.BROWSER_ENABLED = "true";
  assert.ok(roundtableToolIds().includes("mcp__roundtable__browser_snapshot"));
  assert.equal(BROWSER_TOOL_IDS.length, 8);
  const cfg = loadConfig({ KNIGHT_NAME: "Kay", SUBSCRIBE_TOPICS: "x" });
  assert.match(buildPreamble(cfg), /mcp__roundtable__browser_\*/);
  assert.match(buildPreamble(cfg), /spawn_subagent, use the Agent tool/);
});
