/**
 * Tool call hooks for pi-knight — safety, observability, and metrics.
 *
 * Implemented as an inline pi extension (`tool_call`, `tool_result` and
 * `tool_execution_end` events) loaded through the session's resource loader. In pi 1.x
 * AgentSession owns the agent's beforeToolCall/afterToolCall hooks to drive the extension
 * runner, so extensions are the supported way to intercept tool execution.
 */
import { isToolCallEventType, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { checkBashCommand, isTokenSecret, log, redactSecrets } from "@roundtable/knight-core";
import { toolCallsTotal, toolCallDuration, toolCallsBlocked } from "./runtime-metrics.js";

// ─── Pure helpers ──────────────────────────────────────────────────

/** Reason a bash command must be blocked, or undefined when it is allowed. */
export function findBlockedBashReason(command: string): string | undefined {
  return checkBashCommand(command);
}

const isSecret = isTokenSecret;

function truncateArgs(args: unknown): string {
  const str = JSON.stringify(args);
  return str.length > 200 ? str.slice(0, 200) + "…" : str;
}

// ─── Extension ─────────────────────────────────────────────────────

/**
 * Safety guardrails (block dangerous bash / secret writes), secret redaction of tool
 * results, and tool-call logging + metrics. Pass to DefaultResourceLoader `extensionFactories`.
 */
export const toolHooksExtension: ExtensionFactory = (pi) => {
  pi.on("tool_call", (event) => {
    log.debug("Tool call started", {
      tool: event.toolName,
      toolCallId: event.toolCallId,
      argsPreview: truncateArgs(event.input),
    });

    if (isToolCallEventType("bash", event)) {
      const command = event.input.command ?? "";
      const reason = findBlockedBashReason(command);
      if (reason) {
        log.warn("Blocked dangerous bash command", {
          tool: event.toolName,
          toolCallId: event.toolCallId,
          reason,
          command: command.slice(0, 200),
        });
        toolCallsBlocked.inc({ tool: event.toolName, reason });
        return {
          block: true,
          reason: `🛡️ Blocked: ${reason}. This operation is not allowed for safety. Use a safer alternative.`,
        };
      }
    }

    if (isToolCallEventType("write", event) && isSecret(event.input.content ?? "")) {
      log.warn("Blocked secret write", { tool: event.toolName, toolCallId: event.toolCallId });
      toolCallsBlocked.inc({ tool: event.toolName, reason: "secret_in_content" });
      return {
        block: true,
        reason: "🛡️ Blocked: Content appears to contain secrets/credentials. Never write secrets to files.",
      };
    }

    return undefined;
  });

  // Redact secrets before the result enters the agent's context window.
  pi.on("tool_result", (event) => {
    let changed = false;
    const content = event.content.map((block) => {
      if (block.type === "text" && isSecret(block.text)) {
        changed = true;
        return { ...block, text: redactSecrets(block.text, "tokens") };
      }
      return block;
    });
    if (!changed) return undefined;
    log.warn("Sanitized secrets from tool result", { tool: event.toolName, toolCallId: event.toolCallId });
    return { content };
  });

  // Log model/token metadata for each LLM call (payload is passed through unmodified).
  pi.on("before_provider_request", (event, ctx) => {
    try {
      const p = event.payload as any;
      log.info("LLM request payload", {
        model: ctx.model?.id ?? "unknown",
        provider: ctx.model?.provider ?? "unknown",
        messageCount: Array.isArray(p?.messages) ? p.messages.length : undefined,
        toolCount: Array.isArray(p?.tools) ? p.tools.length : 0,
        toolNames: Array.isArray(p?.tools) ? p.tools.map((t: any) => t?.function?.name ?? t?.name).filter(Boolean) : [],
        hasToolChoice: p?.tool_choice !== undefined,
        maxTokens: p?.max_tokens ?? p?.max_completion_tokens,
        stream: p?.stream,
      });
      log.debug("LLM request payload (full)", { payload: p });
    } catch (err) {
      log.warn("before_provider_request hook threw", { error: String(err) });
    }
    return undefined;
  });

  // Fires for every finalized call (including blocked ones), with a monotonic duration.
  pi.on("tool_execution_end", (event) => {
    const duration = event.durationMs ?? 0;
    const tool = event.toolName;
    toolCallsTotal.inc({ tool, status: event.isError ? "error" : "success" });
    toolCallDuration.observe({ tool }, duration / 1000);
    log.info("Tool call completed", {
      tool,
      toolCallId: event.toolCallId,
      duration,
      isError: event.isError,
      resultSize: JSON.stringify(event.result?.content ?? null).length,
    });
  });
};
