/**
 * Knight-to-knight NATS tools, exposed to Claude Code as an MCP server named
 * "roundtable" (tool ids mcp__roundtable__nats_publish, mcp__roundtable__nats_request
 * and mcp__roundtable__find_knights): in process for the sdk runtime, over stdio
 * (`node dist/index.js mcp`) for the cli runtime. Same behavior and payloads as pi-knight's
 * tools/nats.ts, so a claude-knight and a pi-knight can call each other.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  FIND_KNIGHTS_DESCRIPTION,
  FIND_KNIGHTS_PARAMS,
  findKnightsText,
  publishOutOfBand,
  requestKnight,
} from "@roundtable/knight-core";
import { browserEnabled, browserTools, BROWSER_TOOL_IDS } from "./browser.js";


let knightName = "unknown";
let natsPrefix = "fleet-a";

export function configureTools(name: string, resultsPrefix: string): void {
  knightName = name;
  // "rt-dev.results" → "rt-dev"
  natsPrefix = resultsPrefix.replace(/\.results$/, "");
}

type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function text(t: string, isError = false): ToolText {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

const natsPublish = tool(
  "nats_publish",
  [
    "Publish a fire-and-forget message to a NATS subject.",
    "Your task result is published AUTOMATICALLY — do NOT use this for normal task responses.",
    "Use for alerts, reports, broadcasts, or other out-of-band messages, with your table's prefix",
    "(e.g. <prefix>.alerts.<type>, <prefix>.reports.<type>).",
  ].join(" "),
  {
    subject: z.string().describe("Full NATS subject to publish to"),
    message: z.string().describe("Message payload (string or JSON)"),
  },
  async ({ subject, message }) => {
    const r = await publishOutOfBand(subject, message);
    return text(r.text, !r.ok);
  },
);

const natsRequest = tool(
  "nats_request",
  [
    "Send a task to another knight in your table and wait for their response.",
    "Use for cross-knight collaboration: ask a specialist, then continue with their answer.",
    "Only works with knights in YOUR table. Write a self-contained task — the target has no context —",
    "and include 'Do not delegate to other knights' to keep request depth at 1. Each request costs tokens.",
    "Call find_knights first; the knight's name is then enough (its domain comes from its agent card).",
  ].join(" "),
  {
    knight: z.string().describe("Target knight name (e.g. 'galahad')"),
    domain: z
      .string()
      .optional()
      .describe("Task domain of the target knight (e.g. 'security'). Optional: looked up from the knight's agent card when omitted"),
    task: z.string().describe("Clear, self-contained task description"),
    timeout_ms: z.number().int().positive().optional().describe("Timeout in ms (default 600000 = 10 min)"),
  },
  async ({ knight, domain, task, timeout_ms }, extra) => {
    const r = await requestKnight({
      knightName,
      prefix: natsPrefix,
      knight,
      domain,
      task,
      timeoutMs: timeout_ms,
      signal: (extra as { signal?: AbortSignal } | undefined)?.signal,
    });
    return text(r.text, !r.ok);
  },
);

const findKnights = tool(
  "find_knights",
  FIND_KNIGHTS_DESCRIPTION,
  {
    query: z.string().optional().describe(FIND_KNIGHTS_PARAMS.query),
    domain: z.string().optional().describe(FIND_KNIGHTS_PARAMS.domain),
    skill: z.string().optional().describe(FIND_KNIGHTS_PARAMS.skill),
    includeSuspended: z.boolean().optional().describe(FIND_KNIGHTS_PARAMS.includeSuspended),
  },
  async (params) => {
    const { text: t, isError } = await findKnightsText(params);
    return text(t, isError ?? false);
  },
);

/** The "roundtable" MCP server's tools: NATS and find_knights, plus browser_* when the sidecar is enabled. */
export function roundtableTools() {
  const core = [natsPublish, natsRequest, findKnights];
  return browserEnabled() ? [...core, ...browserTools] : core;
}

/**
 * sdk runtime: an in-process SDK MCP server. Build a fresh instance per query
 * (instances hold per-connection state). The cli runtime serves the same tools
 * over stdio instead (mcp-stdio.ts).
 */
export function createRoundtableServer() {
  const tools = roundtableTools();
  // alwaysLoad: keep these in the prompt instead of behind ToolSearch — they are the
  // knight's core collaboration tools and tiny.
  return createSdkMcpServer({ name: "roundtable", version: "0.1.0", tools, alwaysLoad: true });
}

export const NATS_TOOL_IDS = ["mcp__roundtable__nats_publish", "mcp__roundtable__nats_request", "mcp__roundtable__find_knights"];

export function roundtableToolIds(): string[] {
  return browserEnabled() ? [...NATS_TOOL_IDS, ...BROWSER_TOOL_IDS] : NATS_TOOL_IDS;
}
