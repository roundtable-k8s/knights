/**
 * Browser automation tools for Pi SDK agent sessions.
 *
 * Uses agent-browser CLI for token-efficient browser interaction.
 * agent-browser returns structured accessibility trees with refs (@e1, @e2)
 * that are 90% more token-efficient than raw CDP/DOM dumps.
 *
 * Connects to headless Chrome sidecar via BROWSER_CDP_URL.
 * Requires BROWSER_ENABLED=true (set by operator when spec.capabilities.browser is true).
 */

import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { browserEnabled, runBrowser } from "@roundtable/knight-core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

const BROWSER_DISABLED_MSG =
  "Browser capability not enabled. Set spec.capabilities.browser: true in Knight CR.";

function textResult(text: string): AgentToolResult<void> {
  return { content: [{ type: "text", text }], details: undefined };
}

// --- Tool Definitions ---

const OpenParams = Type.Object({
  url: Type.String({ description: "URL to navigate to" }),
});

export const browserOpenTool = defineTool({
  name: "browser_open",
  label: "Browser Open",
  description: "Navigate the browser to a URL. Use for JS-rendered pages, SPAs, form interaction, or when curl is insufficient.",
  parameters: OpenParams,
  async execute(_id, params) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    return textResult(await runBrowser(["open", params.url]) || `Navigated to ${params.url}`);
  },
});

export const browserSnapshotTool = defineTool({
  name: "browser_snapshot",
  label: "Browser Snapshot",
  description:
    "Get the accessibility tree of the current page with element refs (@e1, @e2, etc). Use refs to interact via browser_click, browser_fill. Token-efficient alternative to reading raw HTML.",
  parameters: Type.Object({}),
  async execute() {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    return textResult(await runBrowser(["snapshot"], 15000));
  },
});

const RefParams = Type.Object({
  ref: Type.String({ description: "Element ref from snapshot (e.g. @e2) or CSS selector" }),
});

export const browserClickTool = defineTool({
  name: "browser_click",
  label: "Browser Click",
  description: "Click an element by ref (from snapshot, e.g. @e5) or CSS selector.",
  parameters: RefParams,
  async execute(_id, params) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    return textResult(await runBrowser(["click", params.ref]) || `Clicked ${params.ref}`);
  },
});

const FillParams = Type.Object({
  ref: Type.String({ description: "Element ref from snapshot or CSS selector" }),
  text: Type.String({ description: "Text to fill" }),
});

export const browserFillTool = defineTool({
  name: "browser_fill",
  label: "Browser Fill",
  description: "Clear and fill an input element with text. Uses ref from snapshot.",
  parameters: FillParams,
  async execute(_id, params) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    return textResult(await runBrowser(["fill", params.ref, params.text]) || `Filled ${params.ref}`);
  },
});

export const browserGetTextTool = defineTool({
  name: "browser_get_text",
  label: "Browser Get Text",
  description: "Get text content from a specific element.",
  parameters: RefParams,
  async execute(_id, params) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    return textResult(await runBrowser(["get", "text", params.ref]));
  },
});

export const browserScreenshotTool = defineTool({
  name: "browser_screenshot",
  label: "Browser Screenshot",
  description: "Take a screenshot of the current page.",
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "File path to save screenshot" })),
    full: Type.Optional(Type.Boolean({ description: "Full page capture" })),
  }),
  async execute(_id, params) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    const args = ["screenshot", ...(params.full ? ["--full"] : []), ...(params.path ? [params.path] : [])];
    return textResult((await runBrowser(args)) || "Screenshot captured");
  },
});

const EvalParams = Type.Object({
  js: Type.String({ description: "JavaScript to evaluate in page context" }),
});

export const browserEvalTool = defineTool({
  name: "browser_eval",
  label: "Browser Eval",
  description: "Evaluate JavaScript in the browser page context.",
  parameters: EvalParams,
  async execute(_id, params) {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    const b64 = Buffer.from(params.js).toString("base64");
    return textResult(await runBrowser(["eval", "-b", b64], 30000));
  },
});

export const browserCloseTool = defineTool({
  name: "browser_close",
  label: "Browser Close",
  description: "Close the browser page and free resources.",
  parameters: Type.Object({}),
  async execute() {
    if (!browserEnabled()) return textResult(BROWSER_DISABLED_MSG);
    return textResult(await runBrowser(["close"]) || "Browser closed");
  },
});

/**
 * All browser tools — conditionally registered when BROWSER_ENABLED=true.
 * Uses agent-browser CLI for token-efficient accessibility tree interaction.
 */
export const browserTools = [
  browserOpenTool, browserSnapshotTool, browserClickTool, browserFillTool,
  browserGetTextTool, browserScreenshotTool, browserEvalTool, browserCloseTool,
];
