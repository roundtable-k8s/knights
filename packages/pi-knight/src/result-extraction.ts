import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  describeNoDeliverable,
  type NoDeliverableFacts,
  isGitPush,
  mergePrs,
  parseVerdict,
  prsFromBash,
  resolvePrs,
  SHUTDOWN_INTERRUPTED_MESSAGE,
  ShutdownAbort,
  taskTimeoutMessage,
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

export const TOOL_CALLS_AS_TEXT_REASON =
  "Model returned tool calls as plain text instead of structured tool_calls, so no tool ran. " +
  "The model or its endpoint does not support tool calling in the OpenAI format; use a tool-capable model.";

/** Failure reason for a local model that ended without a deliverable and without any tool call. */
export const LOCAL_NO_TOOL_CALLS_REASON =
  "Local model produced no output and made no tool calls. It may not support tool calling " +
  "(or the endpoint dropped the tools); check the model's tool support and the endpoint logs.";

/** Why and when the task scope aborted, for naming shutdown vs timeout (and the limit) in the failure. */
export interface AbortContext {
  /** `signal.reason`; a ShutdownAbort marks an interruption by knight shutdown. */
  reason?: unknown;
  /** Time the task ran before the abort. */
  elapsedMs: number;
  /** The task's effective time limit. */
  timeoutMs: number;
}

/**
 * Describe why a session ended without a deliverable. The Pi agent loop never throws on
 * LLM failures — a stream error or abort ends the loop silently, recorded only as
 * stopReason "error"/"aborted" (plus errorMessage) on the final assistant message. If we
 * don't look at those, every API failure, rate limit, and timeout gets reported as the
 * generic "no deliverable output", which sends whoever is debugging after the wrong bug.
 */
export function describeSessionFailure(
  sess: AgentSession,
  taskAborted: boolean,
  fromIndex = 0,
  abort?: AbortContext,
): string | undefined {
  const abortedText = (): string => {
    if (abort?.reason instanceof ShutdownAbort) return SHUTDOWN_INTERRUPTED_MESSAGE;
    if (!taskAborted) return "Task aborted before producing output";
    return abort ? taskTimeoutMessage(abort.elapsedMs, abort.timeoutMs) : "Task timed out before producing output";
  };
  const messages = (sess as AgentSession & { messages?: Array<{ role?: string; stopReason?: string; errorMessage?: string }> }).messages;
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= fromIndex; i--) {
      const msg = messages[i];
      if (msg?.role !== "assistant") continue;
      if (msg.stopReason === "error") {
        return `LLM call failed: ${msg.errorMessage ?? "unknown provider error"}`;
      }
      if (msg.stopReason === "aborted") {
        return abortedText();
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
  if (taskAborted) return abortedText();
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
  facts?: NoDeliverableFacts,
): {
  result: string;
  success: boolean;
  error?: string;
} {
  if (deliverable != null) return { result: deliverable, success: true };
  const error = failureReason ?? describeNoDeliverable(facts);
  return { result: error, success: false, error };
}

type TailMessage = { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };

/** The session's messages from `fromIndex` on, or undefined when the session does not expose them. */
function tailMessages(sess: AgentSession, fromIndex: number): TailMessage[] | undefined {
  const messages = (sess as unknown as { messages?: TailMessage[] }).messages;
  return Array.isArray(messages) ? messages.slice(fromIndex) : undefined;
}

/** Content part types of a message with their counts (a plain string content counts as `string`: its length). */
function partCounts(msg: TailMessage | undefined): Record<string, number> {
  const parts: Record<string, number> = {};
  if (Array.isArray(msg?.content)) {
    for (const part of msg.content) {
      const type = (part as { type?: string })?.type ?? "unknown";
      parts[type] = (parts[type] ?? 0) + 1;
    }
  } else if (typeof msg?.content === "string") {
    parts["string"] = msg.content.length;
  }
  return parts;
}

/** How the task's last assistant message ended, from stop reason and part types only (never content). */
export function describeSessionEnd(sess: AgentSession, fromIndex = 0): string | undefined {
  const messages = tailMessages(sess, fromIndex);
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const types = new Set(Object.keys(partCounts(msg)));
    let shape: string;
    if (types.size === 0) shape = "the last message was empty";
    else if (types.size === 1 && types.has("toolCall")) shape = "the last message had only tool calls (a nats_publish with terminate: true ends the task this way)";
    else if (types.size === 1 && types.has("thinking")) shape = "the last message was thinking only";
    else shape = `the last message had ${[...types].sort().join(", ")} parts`;
    return msg.stopReason ? `${shape}, stop reason ${msg.stopReason}` : shape;
  }
  return undefined;
}

/**
 * Compact shape of the session's trailing messages for failure logs: role, stopReason,
 * and content part-type counts (never content itself). Enough to tell "model emitted only
 * tool calls" from "thinking-only reply" from "stream died" without dumping transcripts.
 */
export function summarizeSessionTail(sess: AgentSession, limit = 6, fromIndex = 0): Array<Record<string, unknown>> {
  const messages = tailMessages(sess, fromIndex);
  if (!messages) return [];
  return messages.slice(Math.max(0, messages.length - limit)).map((msg) => ({
    role: msg?.role,
    stopReason: msg?.stopReason,
    ...(msg?.errorMessage ? { errorMessage: msg.errorMessage } : {}),
    parts: partCounts(msg),
  }));
}

/**
 * @param fromIndex only messages at or after this index count: the steps of a chain run
 * share one session, and a step with no text of its own must not publish an earlier step's.
 */
export function getBestAssistantResult(sess: AgentSession, fromIndex = 0): string | undefined {
  const messages = (sess as AgentSession & { messages?: Array<{ role?: string; content?: unknown; stopReason?: string }> }).messages;
  if (!Array.isArray(messages)) {
    const fallback = sess.getLastAssistantText();
    return fallback && isDeliverableAssistantText(fallback) ? fallback : undefined;
  }

  let suspiciousFallback: string | undefined;

  for (let i = messages.length - 1; i >= fromIndex; i--) {
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

const BEFORE_OUTPUT_PHRASE = "before producing output";

/**
 * Opt-in (ABORTED_TASK_IS_FAILURE): when the task's last assistant message ended in an
 * abort or LLM error, return the failure to publish — the reason plus any partial output.
 */
export function describeAbortedTask(
  sess: AgentSession,
  taskAborted: boolean,
  partial: string | undefined,
  fromIndex = 0,
  abort?: AbortContext,
): string | undefined {
  const messages = (sess as AgentSession & { messages?: Array<{ role?: string; stopReason?: string }> }).messages;
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= fromIndex; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error" && msg.stopReason !== "aborted") return undefined;
    const reason = describeSessionFailure(sess, taskAborted, fromIndex, abort) ?? "Task aborted";
    // "before producing output" contradicts the partial output that follows: keep the
    // reason up to that phrase (timeout, shutdown or abort) and attach the partial output.
    const beforeOutput = reason.indexOf(BEFORE_OUTPUT_PHRASE);
    if (partial && beforeOutput >= 0) return `${reason.slice(0, beforeOutput).trim()}. Partial output: ${partial}`;
    if (!partial) return reason;
    return /[.!?]$/.test(reason) ? `${reason} Partial output: ${partial}` : `${reason}. Partial output: ${partial}`;
  }
  return undefined;
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

/**
 * Index of the first message of the current task. Anchored on the last message that
 * existed before the task, not a raw length: auto-compaction replaces the messages with
 * a shorter array, which would make a length-based index skip the final answer. If the
 * anchor was compacted away, fall back to 0 so the answer is never skipped.
 */
export function taskStartIndex(sess: AgentSession, anchor: unknown): number {
  if (anchor === undefined) return 0;
  const messages = (sess as AgentSession & { messages?: unknown[] }).messages;
  if (!Array.isArray(messages)) return 0;
  const i = messages.lastIndexOf(anchor);
  if (i >= 0) return i + 1;
  // The anchor was compacted away (or is a summary Pi rebuilds on each load). Start after the
  // latest compaction summary so text from earlier steps before it is never returned.
  let summary = -1;
  for (let j = messages.length - 1; j >= 0; j--) {
    const role = (messages[j] as { role?: unknown } | undefined)?.role;
    if (role === "compactionSummary" || role === "branchSummary") {
      summary = j;
      break;
    }
  }
  return summary < 0 ? 0 : summary + 1;
}
