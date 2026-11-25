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
import { toolCallDuration, toolCallsBlocked, toolCallsTotal } from "./runtime-metrics.js";
import { recordRateLimit } from "./plan-limits.js";
import { getActivity, isPrCommand, log, mergePrs, prsFromBash, type PRRef } from "@roundtable/knight-core";

export interface StreamState {
  result?: SDKResultMessage;
  sessionId?: string;
  lastAssistantText: string;
  assistantError?: string;
  apiKeySource?: string;
  /** tool_use id → tool name, for tool metrics in the cli runtime. */
  toolNames: Map<string, string>;
  /** tool_use id → start time (ms), to time tool_use → tool_result in the cli runtime. */
  toolStarts: Map<string, number>;
  /** tool_use id → tool name for activity events (both runtimes). */
  activityTools: Map<string, string>;
  /** tool_use id → Bash command, so a blocked call can be logged with its command. */
  bashCommands: Map<string, string>;
  /** tool_use id → Bash command that may open/update a PR (tracked in every runtime). */
  prCommands: Map<string, string>;
  /** PRs opened or updated by the agent's gh/git commands, in order. */
  prs: PRRef[];
}

export function newStreamState(): StreamState {
  return { lastAssistantText: "", toolNames: new Map(), toolStarts: new Map(), activityTools: new Map(), bashCommands: new Map(), prCommands: new Map(), prs: [] };
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

type Block = { type?: string; text?: string; id?: string; name?: string; tool_use_id?: string; is_error?: boolean; input?: unknown; content?: unknown };

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
      if (Array.isArray(content)) {
        for (const b of content) {
          const cmd = (b?.input as { command?: unknown } | undefined)?.command;
          if (b?.type === "tool_use" && b.id && b.name === "Bash" && typeof cmd === "string" && isPrCommand(cmd)) {
            state.prCommands.set(b.id, cmd);
          }
        }
      }
      const act = getActivity(taskId);
      if (act && Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === "tool_use" && b.id && b.name) {
            state.activityTools.set(b.id, b.name);
            act.toolStarted(b.id, b.name, b.input);
          } else if (b?.type === "text" && b.text?.trim() && !msg.parent_tool_use_id) {
            act.assistantMessage(b.text.trim());
          }
        }
      }
      if (ctx.countTools && Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== "tool_use" || !b.id || !b.name) continue;
          state.toolNames.set(b.id, b.name);
          state.toolStarts.set(b.id, Date.now());
          const cmd = (b.input as { command?: unknown } | undefined)?.command;
          if (b.name === "Bash" && typeof cmd === "string") state.bashCommands.set(b.id, cmd);
        }
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
      const content = (msg.message as { content?: unknown })?.content;
      if (!Array.isArray(content)) break;
      const act = getActivity(taskId);
      if (act) {
        for (const b of content as Block[]) {
          if (b?.type !== "tool_result" || !b.tool_use_id) continue;
          const name = state.activityTools.get(b.tool_use_id) ?? "unknown";
          state.activityTools.delete(b.tool_use_id);
          act.toolFinished(b.tool_use_id, name, !!b.is_error, blockText(b.content));
        }
      }
      for (const b of content as Block[]) {
        if (b?.type !== "tool_result" || !b.tool_use_id) continue;
        const cmd = state.prCommands.get(b.tool_use_id);
        if (cmd === undefined) continue;
        state.prCommands.delete(b.tool_use_id);
        if (!b.is_error) mergePrs(state.prs, prsFromBash(cmd, blockText(b.content)));
      }
      if (!ctx.countTools) break;
      for (const b of content as Block[]) {
        if (b?.type !== "tool_result") continue;
        const tool = (b.tool_use_id && state.toolNames.get(b.tool_use_id)) || "unknown";
        const command = (b.tool_use_id && state.bashCommands.get(b.tool_use_id)) || "";
        if (b.tool_use_id) {
          state.toolNames.delete(b.tool_use_id);
          const started = state.toolStarts.get(b.tool_use_id);
          state.toolStarts.delete(b.tool_use_id);
          if (started !== undefined) toolCallDuration.observe({ tool }, (Date.now() - started) / 1000);
          state.bashCommands.delete(b.tool_use_id);
        }
        toolCallsTotal.inc({ tool, status: b.is_error ? "error" : "success" });
        const text = blockText(b.content);
        const at = text.indexOf(BLOCK_REASON_PREFIX);
        if (b.is_error && at >= 0) {
          const reason = text.slice(at + BLOCK_REASON_PREFIX.length).split("\n")[0]!.trim();
          log.warn("Blocked dangerous bash command", { taskId, reason, command: command.slice(0, 200) });
          toolCallsBlocked.inc({ tool, reason });
        }
      }
      break;
    }
    case "rate_limit_event":
      recordRateLimit(msg.rate_limit_info);
      if (msg.rate_limit_info.status !== "allowed") {
        log.warn("Claude plan limit warning", { ...msg.rate_limit_info });
      }
      break;
    case "result":
      state.result = msg;
      break;
  }
}
