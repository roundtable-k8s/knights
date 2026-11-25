import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  isGitPush,
  mergePrs,
  parseVerdict,
  prsFromBash,
  resolvePrs,
  type PRRef,
  type Verdict,
} from "@roundtable/knight-core";

export const NON_DELIVERABLE_PATTERNS = [
  /^\s*\{\s*"(?:type|name)"\s*:\s*"function"/s,
  /^\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:/s,
  /^\s*\{\s*"arguments"\s*:\s*\{/s,
  /"tool_calls"\s*:/s,
  /"function_call"\s*:/s,
  /assistant to=/i,
];

export function extractTextFromAssistantContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => ((part as { text?: string }).text ?? "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function isDeliverableAssistantText(text: string): boolean {
  if (!text) return false;
  return !NON_DELIVERABLE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Machine-readable refusal reason for provider failures that mean "don't retry
 * now, the account can't afford it" — like OpenRouter's 402: OpenRouter reserves
 * credit for the full max_tokens up front, so a request with a large budget can
 * fail with "This request requires more credits, or fewer max_tokens" while
 * plenty of credit remains for normal-sized replies. Reported on the task result
 * as `refused: "credits"` (machine-readable, cf. Claude plan-quota refusal in
 * roundtable#321) so the pipeline can defer instead of escalating as a bug.
 */
export function refusalCode(reason?: string): "credits" | undefined {
  if (!reason) return undefined;
  if (!/\b402\b/.test(reason)) return undefined;
  return /credit|max[ _-]?tokens/i.test(reason) ? "credits" : undefined;
}

/**
 * Describe why a session ended without a deliverable. The Pi agent loop never throws on
 * LLM failures — a stream error or abort ends the loop silently, recorded only as
 * stopReason "error"/"aborted" (plus errorMessage) on the final assistant message. If we
 * don't look at those, every API failure, rate limit, and timeout gets reported as the
 * generic "no deliverable output", which sends whoever is debugging after the wrong bug.
 */
export const TOOL_CALLS_AS_TEXT_REASON =
  "Model returned tool calls as plain text instead of structured tool_calls, so no tool ran. " +
  "The model or its endpoint does not support tool calling in the OpenAI format; use a tool-capable model.";

/** Failure reason for a local model that ended without a deliverable and without any tool call. */
export const LOCAL_NO_TOOL_CALLS_REASON =
  "Local model produced no output and made no tool calls. It may not support tool calling " +
  "(or the endpoint dropped the tools); check the model's tool support and the endpoint logs.";

export function describeSessionFailure(
  sess: AgentSession,
  taskAborted: boolean,
): string | undefined {
  const messages = (sess as AgentSession & { messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string }> }).messages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role !== "assistant") continue;
      if (msg.stopReason === "error") {
        return `LLM call failed: ${msg.errorMessage ?? "unknown provider error"}`;
      }
      if (msg.stopReason === "aborted") {
        return taskAborted
          ? "Task aborted before producing output (task timeout)"
          : "Task aborted before producing output";
      }
      // A normal stop whose text is a raw tool-call payload: the model "called" a tool in
      // prose instead of structured tool_calls, so nothing ran (#99, #27).
      if (/^\s*\{/.test(extractTextFromAssistantContent((msg as { content?: unknown }).content)) &&
          !isDeliverableAssistantText(extractTextFromAssistantContent((msg as { content?: unknown }).content))) {
        return TOOL_CALLS_AS_TEXT_REASON;
      }
      break; // last assistant message is a normal stop — fall through to generic
    }
  }
  if (taskAborted) return "Task aborted before producing output (task timeout)";
  return undefined;
}

/**
 * Map an extracted deliverable (or undefined) to a task outcome. When the agent yields
 * nothing deliverable, the outcome is an explicit failure with an error message — never a
 * sentinel string published as a successful result. (#31) A specific failure reason
 * (LLM error, abort/timeout) takes precedence over the generic no-output message so the
 * real cause is never masked.
 */
export function resolveTaskOutcome(
  deliverable: string | undefined,
  failureReason?: string,
): {
  result: string;
  success: boolean;
  error?: string;
} {
  if (deliverable != null) return { result: deliverable, success: true };
  const error = failureReason ?? "Agent produced no deliverable output";
  return { result: error, success: false, error };
}

/**
 * Compact shape of the session's trailing messages for failure logs: role, stopReason,
 * and content part-type counts (never content itself). Enough to tell "model emitted only
 * tool calls" from "thinking-only reply" from "stream died" without dumping transcripts.
 */
export function summarizeSessionTail(sess: AgentSession, limit = 6): Array<Record<string, unknown>> {
  const messages = (sess as unknown as { messages?: Array<{ role?: string; content?: unknown; stopReason?: string; errorMessage?: string }> }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.slice(-limit).map((msg) => {
    const parts: Record<string, number> = {};
    if (Array.isArray(msg?.content)) {
      for (const part of msg.content) {
        const type = (part as { type?: string })?.type ?? "unknown";
        parts[type] = (parts[type] ?? 0) + 1;
      }
    } else if (typeof msg?.content === "string") {
      parts["string"] = msg.content.length;
    }
    return {
      role: msg?.role,
      stopReason: msg?.stopReason,
      ...(msg?.errorMessage ? { errorMessage: msg.errorMessage } : {}),
      parts,
    };
  });
}

export function getBestAssistantResult(sess: AgentSession): string | undefined {
  const messages = (sess as AgentSession & { messages?: Array<{ role?: string; content?: unknown; stopReason?: string }> }).messages;
  if (!Array.isArray(messages)) {
    const fallback = sess.getLastAssistantText();
    return fallback && isDeliverableAssistantText(fallback) ? fallback : undefined;
  }

  let suspiciousFallback: string | undefined;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason === "aborted" && extractTextFromAssistantContent(msg.content).length === 0) continue;

    const text = extractTextFromAssistantContent(msg.content);
    if (!text) continue;
    if (isDeliverableAssistantText(text)) return text;
    if (!suspiciousFallback) suspiciousFallback = text;
  }

  return suspiciousFallback;
}

/** Structured TaskResult fields `prs` and `verdict` (omitted by the caller when empty). */
export interface Structured {
  prs: PRRef[];
  verdict?: Verdict;
}

/** `{command, output}` pairs for the successful bash calls in pi session messages. */
export function bashCalls(messages: unknown[]): Array<{ command: string; output: string }> {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const m of messages as Array<Record<string, any>>) {
    if (m?.role !== "toolResult" || !m.toolCallId) continue;
    const text = Array.isArray(m.content)
      ? m.content.map((p: any) => (p?.type === "text" ? p.text ?? "" : "")).join("\n")
      : typeof m.content === "string" ? m.content : "";
    results.set(m.toolCallId, { text, isError: Boolean(m.isError) });
  }
  const calls: Array<{ command: string; output: string }> = [];
  for (const m of messages as Array<Record<string, any>>) {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p?.type !== "toolCall" || p.name !== "bash") continue;
      const command = p.arguments?.command;
      const res = results.get(p.id);
      if (typeof command !== "string" || !res || res.isError) continue;
      calls.push({ command, output: res.text });
    }
  }
  return calls;
}

/**
 * PRs from the gh/git commands the agent ran (core `prsFromBash`), falling back to
 * PR URLs in the final message, and the verdict from a final `Verdict:` line.
 * pi-specific: when the fallback is used and the agent ran `git push`, those PRs
 * are reported as updated.
 *
 * @param messages only the messages of THIS task (sessions are shared across a run).
 */
export function extractStructured(messages: unknown[], finalText: string): Structured {
  const fromCommands: PRRef[] = [];
  let pushed = false;
  for (const { command, output } of bashCalls(messages)) {
    if (command.split(/&&|\|\||;|\n|\|/).some(isGitPush)) pushed = true;
    mergePrs(fromCommands, prsFromBash(command, output));
  }
  let prs = resolvePrs(fromCommands, finalText);
  if (!fromCommands.length && pushed) prs = prs.map((p) => ({ ...p, action: "updated" as const }));
  return { prs, verdict: parseVerdict(finalText) };
}
