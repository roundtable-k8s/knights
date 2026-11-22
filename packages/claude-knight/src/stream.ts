/**
 * Consume Claude Code's message stream, whichever runtime produced it. The
 * Agent SDK's query() yields the same messages the CLI prints with
 * `--output-format stream-json --verbose` (the SDK parses that very stream),
 * so one consumer serves both: it tracks the session id, the last top-level
 * assistant text, assistant errors, the auth source and the final result, and
 * feeds rate-limit events to the plan reserve.
 */
import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { KnightConfig } from "./config.js";
import { BLOCK_REASON_PREFIX } from "./guardrails.js";
import { log } from "./logger.js";
import { toolCallsBlocked, toolCallsTotal } from "./metrics.js";
import { recordRateLimit } from "./plan-limits.js";

export interface StreamState {
  result?: SDKResultMessage;
  sessionId?: string;
  lastAssistantText: string;
  assistantError?: string;
  apiKeySource?: string;
  /** tool_use id → tool name, for tool metrics in the cli runtime. */
  toolNames: Map<string, string>;
}

export function newStreamState(): StreamState {
  return { lastAssistantText: "", toolNames: new Map() };
}

export interface StreamContext {
  config: KnightConfig;
  taskId: string;
  /**
   * Count tool calls from the stream. The cli runtime needs this; the sdk
   * runtime counts them with in-process PostToolUse hooks instead.
   */
  countTools: boolean;
}

/** Auth sources that mean Claude Code is billing per token, not to the plan. */
export const API_KEY_SOURCES = ["ANTHROPIC_API_KEY", "apiKeyHelper"];

export class ApiKeyAuthError extends Error {}

type Block = { type?: string; text?: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return (content as Block[]).map((b) => (b?.type === "text" ? (b.text ?? "") : "")).join("\n");
  return "";
}

/**
 * Apply one stream message to the state. Throws ApiKeyAuthError when a
 * subscription knight's Claude Code reports API-key auth, so the caller stops
 * the run before any work is billed.
 */
export function applyMessage(msg: SDKMessage, state: StreamState, ctx: StreamContext): void {
  const { config, taskId } = ctx;
  if ("session_id" in msg && typeof msg.session_id === "string") state.sessionId = msg.session_id;
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        state.apiKeySource = msg.apiKeySource;
        log.info("Claude Code session started", {
          taskId,
          runtime: config.runtime,
          sessionId: msg.session_id,
          model: msg.model,
          version: msg.claude_code_version,
          apiKeySource: msg.apiKeySource,
          mcp: msg.mcp_servers?.map((s) => `${s.name}:${s.status}`),
          skills: msg.skills?.length,
        });
        // Belt and braces for the credential stripping in auth.ts.
        if (config.authMode === "subscription" && API_KEY_SOURCES.includes(msg.apiKeySource)) {
          throw new ApiKeyAuthError(`Refusing to run: subscription mode but Claude Code authenticated via ${msg.apiKeySource}`);
        }
      }
      break;
    case "assistant": {
      const content = (msg.message as { content?: Block[] })?.content;
      if (ctx.countTools && Array.isArray(content)) {
        for (const b of content) if (b?.type === "tool_use" && b.id && b.name) state.toolNames.set(b.id, b.name);
      }
      if (msg.parent_tool_use_id) break; // subagent chatter, not the deliverable
      if (msg.error) state.assistantError = msg.error;
      const text = Array.isArray(content)
        ? content.filter((b) => b.type === "text" && b.text).map((b) => b.text!.trim()).join("\n").trim()
        : "";
      if (text) state.lastAssistantText = text;
      break;
    }
    case "user": {
      if (!ctx.countTools) break;
      const content = (msg.message as { content?: unknown })?.content;
      if (!Array.isArray(content)) break;
      for (const b of content as Block[]) {
        if (b?.type !== "tool_result") continue;
        const tool = (b.tool_use_id && state.toolNames.get(b.tool_use_id)) || "unknown";
        if (b.tool_use_id) state.toolNames.delete(b.tool_use_id);
        toolCallsTotal.inc({ tool, status: b.is_error ? "error" : "success" });
        const text = blockText(b.content);
        const at = text.indexOf(BLOCK_REASON_PREFIX);
        if (b.is_error && at >= 0) {
          const reason = text.slice(at + BLOCK_REASON_PREFIX.length).split("\n")[0]!.trim();
          log.warn("Blocked dangerous bash command", { taskId, reason });
          toolCallsBlocked.inc({ tool, reason });
        }
      }
      break;
    }
    case "rate_limit_event":
      recordRateLimit(config.knightName, msg.rate_limit_info);
      if (msg.rate_limit_info.status !== "allowed") {
        log.warn("Claude plan limit warning", { ...msg.rate_limit_info });
      }
      break;
    case "result":
      state.result = msg;
      break;
  }
}
