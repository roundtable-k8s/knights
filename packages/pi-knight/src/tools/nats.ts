/**
 * NATS communication tools for Pi SDK agent sessions.
 *
 * Provides native tool-loop integration for knight-to-knight
 * communication over NATS JetStream. These tools are the primary
 * mechanism for cross-knight collaboration — no shell scripts or
 * external skills needed.
 *
 * Table-aware: all subjects use the knight's own NATS prefix,
 * derived from NATS_RESULTS_PREFIX at startup.
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { publishOutOfBand, requestKnight } from "@roundtable/knight-core";
import { findKnightsTool } from "./find-knights.js";

// Knight identity — set once at startup for self-echo prevention
let _knightName = "unknown";
export function setKnightName(name: string): void { _knightName = name; }

// NATS prefix — derived from config at startup (e.g. "fleet-a" or "rt-dev")
let _natsPrefix = "fleet-a";
export function setNatsPrefix(prefix: string): void { _natsPrefix = prefix; }

// --- Parameter Schemas ---

const PublishParams = Type.Object({
  subject: Type.String({ description: "Full NATS subject to publish to" }),
  message: Type.String({ description: "Message payload (string or JSON)" }),
});

const RequestParams = Type.Object({
  knight: Type.String({ description: "Target knight name (e.g. 'galahad', 'rt-operator')" }),
  domain: Type.Optional(Type.String({ description: "Task domain of the target knight (e.g. 'security'). Optional: looked up from the knight's agent card when omitted" })),
  task: Type.String({ description: "Clear, self-contained task description — the target knight has NO context about your current work" }),
  timeout_ms: Type.Optional(Type.Number({ description: "Timeout in ms (default: 600000 = 10 min). Increase for complex tasks." })),
});

// --- Helpers ---

function textResult(text: string): AgentToolResult<void> {
  return { content: [{ type: "text", text }], details: undefined };
}

/**
 * nats_publish — Fire-and-forget message to any NATS subject.
 *
 * Your normal task results are published automatically by the runtime.
 * Only use this for OUT-OF-BAND messaging: alerts, reports, broadcasts.
 */
export const natsPublishTool = defineTool({
  name: "nats_publish",
  label: "NATS Publish",
  description: [
    "Publish a fire-and-forget message to a NATS subject.",
    "Your task results are published AUTOMATICALLY — do NOT use this for normal task responses.",
    "Use for: alerts, reports, broadcasts, or out-of-band messages.",
  ].join(" "),
  promptSnippet: [
    `Your NATS table prefix is dynamically set at startup (current: check your SUBSCRIBE_TOPICS).`,
    `Subject format: <your-prefix>.alerts.<type>, <your-prefix>.reports.<type>, etc.`,
    `NEVER publish empty messages. NEVER use this for task results (the runtime handles that).`,
  ].join("\n"),
  promptGuidelines: [
    "Only use for out-of-band messaging — your task result is auto-published by the runtime",
    "Use your table's prefix in subjects (visible in your startup logs)",
    "Never publish empty messages",
  ],
  parameters: PublishParams,
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    const r = await publishOutOfBand(params.subject, params.message);
    // terminate: the message is delivered, so no follow-up LLM turn is needed.
    return r.ok ? { ...textResult(r.text), terminate: true } : textResult(r.text);
  },
});

/**
 * nats_request — Send a task to another knight and wait for their response.
 *
 * This is the primary mechanism for cross-knight collaboration. It:
 * 1. Generates a unique task ID
 * 2. Subscribes to the result subject for that task
 * 3. Publishes the task to the target knight's domain subject
 * 4. Blocks until the target responds (or timeout)
 * 5. Returns the result text into your tool loop
 *
 * IMPORTANT: Only request knights within YOUR OWN table. Cross-table
 * requests will timeout because subjects don't cross table boundaries.
 */
const natsRequestTool = defineTool({
  name: "nats_request",
  label: "Knight Request",
  description: [
    "Send a task to another knight in your table and wait for their response.",
    "Use for cross-knight collaboration: ask a specialist for help, then continue with their answer.",
    "ONLY works with knights in YOUR table — cross-table requests will timeout.",
  ].join(" "),
  promptSnippet: [
    `## Knight-to-Knight Communication`,
    ``,
    `Use nats_request to ask another knight for help. The request is routed`,
    `through your table's NATS streams automatically.`,
    ``,
    `Call find_knights first to see who is at your table; then the knight's name is enough`,
    `(the domain is looked up from its agent card).`,
    ``,
    `### Rules`,
    `- **Stay in your table**: only request knights that share your NATS prefix.`,
    `  Cross-table requests WILL timeout (different streams).`,
    `- **Be specific**: write a clear, complete task — the target has NO context.`,
    `- **Max depth 1**: include "Do not delegate to other knights" in your task.`,
    `- **Cost-aware**: each request costs tokens. Only ask when genuinely needed.`,
    ``,
    `### Usage`,
    `\`\`\``,
    `nats_request(`,
    `  knight: "galahad",`,
    `  task: "Check if CVE-2026-1234 affects any images in the roundtable namespace. Do not delegate to other knights."`,
    `)`,
    `\`\`\``,
    ``,
    `If you need a knight from a DIFFERENT table, say so in your task output`,
    `and let the orchestrator (Tim or a chain) handle cross-table coordination.`,
  ].join("\n"),
  promptGuidelines: [
    "Only request knights within your own table — cross-table requests timeout",
    "Write clear, self-contained task descriptions with full context",
    "Include 'Do not delegate to other knights' to prevent request chains",
    "Default timeout is 10 minutes — increase for complex tasks",
    "Call find_knights before delegating; pass domain only if find_knights has no roster",
  ],
  parameters: RequestParams,
  async execute(_toolCallId, params, signal, onUpdate, _ctx) {
    const r = await requestKnight({
      knightName: _knightName,
      prefix: _natsPrefix,
      knight: params.knight,
      domain: params.domain,
      task: params.task,
      timeoutMs: params.timeout_ms,
      signal,
      onProgress: (t) => onUpdate?.(textResult(t)),
    });
    return textResult(r.text);
  },
});

/**
 * All NATS tools (and find_knights, registered next to nats_request) for registration with Pi SDK.
 */
export const natsTools = [natsPublishTool, natsRequestTool, findKnightsTool];
