/**
 * Knight-to-knight NATS tools, exposed to Claude Code as an MCP server named
 * "roundtable" (tool ids mcp__roundtable__nats_publish and
 * mcp__roundtable__nats_request): in process for the sdk runtime, over stdio
 * (`node dist/index.js mcp`) for the cli runtime. Same behavior and payloads as pi-knight's
 * tools/nats.ts, so a claude-knight and a pi-knight can call each other.
 */
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getConnection, getJetStream, StringCodec, log } from "@roundtable/knight-core";
import { browserEnabled, browserTools, BROWSER_TOOL_IDS } from "./browser.js";

const sc = StringCodec();

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

export function formatRequestResponse(knight: string, raw: string): ToolText {
  try {
    const result = JSON.parse(raw);
    const success = result.success ?? true;
    const body = result.result ?? result.output ?? raw;
    const cost = typeof result.cost === "number" ? result.cost : 0;
    const duration = typeof result.duration_ms === "number" ? result.duration_ms : 0;
    if (success) {
      return text(`Response from ${knight} (${Math.round(duration / 1000)}s, $${cost.toFixed(4)}):\n\n${body}`);
    }
    return text(`${knight} reported failure: ${result.error ?? body}`, true);
  } catch {
    return text(`Raw response from ${knight}: ${raw}`);
  }
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
    const js = getJetStream();
    if (!js) return text("Error: NATS not connected", true);
    if (!message || message.trim().length === 0) {
      return text("Error: Cannot publish an empty message.", true);
    }
    try {
      await js.publish(subject, sc.encode(message));
      log.info("nats_publish tool", { subject, size: message.length });
      return text(`Published to ${subject} (${message.length} bytes)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("nats_publish failed", { subject, error: msg });
      return text(`Error publishing to ${subject}: ${msg}`, true);
    }
  },
);

const natsRequest = tool(
  "nats_request",
  [
    "Send a task to another knight in your table and wait for their response.",
    "Use for cross-knight collaboration: ask a specialist, then continue with their answer.",
    "Only works with knights in YOUR table. Write a self-contained task — the target has no context —",
    "and include 'Do not delegate to other knights' to keep request depth at 1. Each request costs tokens.",
  ].join(" "),
  {
    knight: z.string().describe("Target knight name (e.g. 'galahad')"),
    domain: z.string().describe("Task domain matching the target knight's NATS filter (e.g. 'security')"),
    task: z.string().describe("Clear, self-contained task description"),
    timeout_ms: z.number().int().positive().optional().describe("Timeout in ms (default 600000 = 10 min)"),
  },
  async ({ knight, domain, task, timeout_ms }) => {
    const js = getJetStream();
    const nc = getConnection();
    if (!js || !nc) return text("Error: NATS not connected", true);
    if (!task || task.trim().length === 0) return text("Error: Cannot send an empty task.", true);

    const timeoutMs = timeout_ms ?? 600_000;
    const taskId = `${knight}-xreq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const taskSubject = `${natsPrefix}.tasks.${domain}.${taskId}`;
    const resultSubject = `${natsPrefix}.results.${taskId}`;

    log.info("nats_request: dispatching", { knight, domain, taskId, timeoutMs });
    try {
      // Subscribe before publishing so a fast reply can't be missed.
      const sub = nc.subscribe(resultSubject, { max: 1, timeout: timeoutMs });
      await js.publish(
        taskSubject,
        sc.encode(
          JSON.stringify({
            task,
            task_id: taskId,
            domain,
            from: knightName.toLowerCase(),
            dispatched_by: knightName,
            timestamp: new Date().toISOString(),
            metadata: { timeout_ms: timeoutMs, table_prefix: natsPrefix },
          }),
        ),
      );
      for await (const msg of sub) {
        const response = formatRequestResponse(knight, sc.decode(msg.data));
        log.info("nats_request: response received", { taskId, isError: response.isError ?? false });
        return response;
      }
      return text(`Timeout: ${knight} did not respond within ${Math.round(timeoutMs / 1000)}s`, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // nats.js rejects the iterator on subscription timeout
      if (/timeout/i.test(msg)) {
        return text(`Timeout: ${knight} did not respond within ${Math.round(timeoutMs / 1000)}s`, true);
      }
      log.error("nats_request failed", { taskId, error: msg });
      return text(`Error requesting from ${knight}: ${msg}`, true);
    }
  },
);

/** The "roundtable" MCP server's tools: NATS, plus browser_* when the sidecar is enabled. */
export function roundtableTools() {
  return browserEnabled() ? [natsPublish, natsRequest, ...browserTools] : [natsPublish, natsRequest];
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

export const NATS_TOOL_IDS = ["mcp__roundtable__nats_publish", "mcp__roundtable__nats_request"];

export function roundtableToolIds(): string[] {
  return browserEnabled() ? [...NATS_TOOL_IDS, ...BROWSER_TOOL_IDS] : NATS_TOOL_IDS;
}
