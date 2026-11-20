/**
 * Browser tools for the headless Chrome sidecar the operator adds when a Knight
 * sets spec.capabilities.browser (it also sets BROWSER_ENABLED=true and
 * BROWSER_CDP_URL). Same tool set as pi-knight's tools/browser.ts, driving the
 * agent-browser CLI (compact accessibility trees with @e refs), exposed through
 * the in-process "roundtable" MCP server as mcp__roundtable__browser_*.
 *
 * Differences from pi-knight: arguments go to agent-browser as an argv array
 * (no shell, so page text or selectors can't inject commands), and screenshots
 * come back as an image Claude can see, not just a file path.
 */
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { log } from "./logger.js";

export function browserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["BROWSER_ENABLED"] === "true";
}

const CDP_URL = () => process.env["BROWSER_CDP_URL"] || "http://localhost:9222";
const BIN = () => process.env["AGENT_BROWSER_BIN"] || "agent-browser";
const MAX_OUTPUT = 100_000;
const MAX_IMAGE_BYTES = 4_500_000;

export type ExecFn = (bin: string, args: string[], timeoutMs: number) => Promise<string>;

const defaultExec: ExecFn = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout.trim());
    });
  });

let exec: ExecFn = defaultExec;
/** Test hook. */
export function setBrowserExec(fn: ExecFn | null): void {
  exec = fn ?? defaultExec;
}

/** Reconnect first: the agent-browser daemon can die between calls; connect is idempotent. */
export async function runBrowser(args: string[], timeoutMs = 30_000): Promise<string> {
  try {
    await exec(BIN(), ["connect", CDP_URL()], 10_000);
  } catch {
    // best effort — the command may still work through an existing daemon
  }
  const out = await exec(BIN(), args, timeoutMs);
  return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n…[truncated ${out.length - MAX_OUTPUT} chars]` : out;
}

type Content = Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }] as Content, ...(isError ? { isError: true } : {}) });

async function guarded(name: string, fn: () => Promise<{ content: Content; isError?: boolean }>) {
  if (!browserEnabled()) {
    return text("Browser capability not enabled. Set spec.capabilities.browser: true in the Knight CR.", true);
  }
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("browser tool failed", { tool: name, error: msg.slice(0, 500) });
    return text(`Error: ${msg}`, true);
  }
}

const ref = z.string().describe("Element ref from browser_snapshot (e.g. @e5) or a CSS selector");

export const browserTools = [
  tool(
    "browser_open",
    "Navigate the headless browser to a URL. Use for JS-rendered pages, SPAs, logins and forms, or when WebFetch/curl is not enough. Then call browser_snapshot to see the page.",
    { url: z.string().describe("URL to navigate to") },
    ({ url }) => guarded("open", async () => text((await runBrowser(["open", url], 60_000)) || `Navigated to ${url}`)),
  ),
  tool(
    "browser_snapshot",
    "Accessibility tree of the current page with element refs (@e1, @e2, …) for browser_click/browser_fill. Far cheaper than raw HTML.",
    {},
    () => guarded("snapshot", async () => text(await runBrowser(["snapshot"], 20_000))),
  ),
  tool(
    "browser_click",
    "Click an element by ref (from browser_snapshot) or CSS selector.",
    { ref },
    ({ ref: r }) => guarded("click", async () => text((await runBrowser(["click", r])) || `Clicked ${r}`)),
  ),
  tool(
    "browser_fill",
    "Clear an input and type text into it.",
    { ref, text: z.string().describe("Text to fill") },
    ({ ref: r, text: t }) => guarded("fill", async () => text((await runBrowser(["fill", r, t])) || `Filled ${r}`)),
  ),
  tool(
    "browser_get_text",
    "Text content of one element.",
    { ref },
    ({ ref: r }) => guarded("get_text", async () => text(await runBrowser(["get", "text", r]))),
  ),
  tool(
    "browser_screenshot",
    "Screenshot the current page. Returns the image so you can look at it, and saves it to `path` (default /data/scratch/screenshots/<timestamp>.png).",
    {
      path: z.string().optional().describe("Where to save the PNG"),
      full: z.boolean().optional().describe("Capture the full scrollable page"),
    },
    ({ path, full }) =>
      guarded("screenshot", async () => {
        const file = path ?? `/data/scratch/screenshots/${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
        mkdirSync(dirname(file), { recursive: true });
        await runBrowser(["screenshot", ...(full ? ["--full"] : []), file], 30_000);
        const size = statSync(file).size;
        if (size > MAX_IMAGE_BYTES) return text(`Screenshot saved to ${file} (${size} bytes — too large to return inline; Read it or crop).`);
        return {
          content: [
            { type: "image", data: readFileSync(file).toString("base64"), mimeType: "image/png" },
            { type: "text", text: `Saved to ${file}` },
          ],
        };
      }),
  ),
  tool(
    "browser_eval",
    "Evaluate JavaScript in the page and return the result.",
    { js: z.string().describe("JavaScript to evaluate in the page context") },
    ({ js }) => guarded("eval", async () => text(await runBrowser(["eval", "-b", Buffer.from(js).toString("base64")]))),
  ),
  tool(
    "browser_close",
    "Close the page and free browser resources when done.",
    {},
    () => guarded("close", async () => text((await runBrowser(["close"])) || "Browser closed")),
  ),
];

export const BROWSER_TOOL_IDS = browserTools.map((t) => `mcp__roundtable__${t.name}`);
