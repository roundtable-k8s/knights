import { trace } from "@opentelemetry/api";
import { activeTraceContext, boundText, captureContent, contentMaxBytes, endSpan, setContentAttribute, startChildSpan } from "@roundtable/knight-core";

/**
 * Turns pi session events into `chat <model>` (one per LLM turn) and `execute_tool <tool>`
 * (one per tool call) child spans of the task span. Prompt, response and tool content go on as
 * redacted, size-capped attributes unless ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT=false.
 * With no SDK registered every span is a no-op.
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as any).type === "text" ? String((b as any).text ?? "") : ""))
    .join("");
}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "";
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return String(v);
  }
}

export class SessionSpans {
  private chat?: ReturnType<typeof startChildSpan>;
  private tools = new Map<string, ReturnType<typeof startChildSpan>>();
  private readonly attrs: Record<string, string>;
  /** Newest messages as `{role, content}`, bounded to the content cap: the input of the next chat turn. */
  private history: { role: string; content: string }[] = [];
  private historyBytes = 0;
  private historyDropped = false;

  constructor(
    private readonly model: string,
    ids: { knight: string; table?: string },
    private readonly parent = activeTraceContext(),
    /** The session's system prompt, read when a chat span starts. */
    private readonly systemPrompt?: () => string | undefined,
  ) {
    this.attrs = { "roundtable.knight": ids.knight, "roundtable.table": ids.table || "none" };
  }

  handle(e: any): void {
    switch (e?.type) {
      case "turn_start":
        this.endChat();
        this.chat = startChildSpan(
          `chat ${this.model}`,
          { ...this.attrs, "gen_ai.operation.name": "chat", "gen_ai.request.model": this.model },
          { parent: this.parent },
        );
        this.setContent(this.chat, "gen_ai.system_instructions", () => this.systemPrompt?.() ?? "");
        break;
      case "message_end": {
        const m = e.message;
        if (m?.role !== "assistant") {
          if (m?.role === "user" || m?.role === "toolResult") this.remember(m.role, textOf(m.content));
          break;
        }
        // The prompt's message_end arrives after turn_start, so the input is only complete here.
        if (this.chat) {
          const chat = this.chat;
          this.setContent(chat, "gen_ai.input.messages", () => JSON.stringify(this.history));
          if (this.historyDropped && captureContent()) chat.setAttribute("roundtable.content.truncated", true);
          this.setContent(chat, "gen_ai.output.messages", () => JSON.stringify([this.outputMessage(m)]));
        }
        this.remember("assistant", textOf(m.content));
        const a: Record<string, string | number> = {};
        if (typeof m.model === "string" && m.model) a["gen_ai.response.model"] = m.model;
        if (Number.isFinite(m.usage?.input)) a["gen_ai.usage.input_tokens"] = m.usage.input;
        if (Number.isFinite(m.usage?.output)) a["gen_ai.usage.output_tokens"] = m.usage.output;
        const failed = m.stopReason === "error" || m.stopReason === "aborted";
        this.endChat(a, failed ? String(m.errorMessage ?? m.stopReason) : undefined);
        break;
      }
      case "compaction_end":
        this.event("compaction", {
          reason: String(e.reason),
          aborted: Boolean(e.aborted),
          will_retry: Boolean(e.willRetry),
        });
        break;
      case "auto_retry_start":
        this.event("llm.retry", {
          attempt: Number(e.attempt),
          max_attempts: Number(e.maxAttempts),
          delay_ms: Number(e.delayMs),
          ...this.errorAttr(e.errorMessage),
        });
        break;
      case "auto_retry_end":
        this.event("llm.retry", { attempt: Number(e.attempt), success: Boolean(e.success), ...this.errorAttr(e.finalError) });
        break;
      case "tool_execution_start": {
        const id = String(e.toolCallId);
        const name = String(e.toolName);
        this.tools.get(id)?.end();
        this.tools.set(
          id,
          startChildSpan(
            `execute_tool ${name}`,
            { ...this.attrs, "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name, "gen_ai.tool.call.id": id },
            { parent: this.parent },
          ),
        );
        this.setContent(this.tools.get(id)!, "gen_ai.tool.call.arguments", () => asText(e.args));
        break;
      }
      case "tool_execution_end": {
        const id = String(e.toolCallId);
        const span = this.tools.get(id);
        if (!span) break;
        this.tools.delete(id);
        this.setContent(span, "gen_ai.tool.call.result", () => textOf(e.result?.content) || asText(e.result?.content));
        endSpan(span, e.isError ? { error: "tool error" } : {});
        break;
      }
    }
  }

  /** Add an event to the task span; a no-op without an SDK. */
  private event(name: string, attributes: Record<string, string | number | boolean>): void {
    trace.getSpan(this.parent)?.addEvent(name, attributes);
  }

  /** Error text goes on the event redacted and cut to 500 chars; empty when absent. */
  private errorAttr(err: unknown): { error?: string } {
    if (typeof err !== "string" || !err) return {};
    return { error: boundText(err, 500).text };
  }

  /** End every span still open (task finished or aborted). Idempotent. */
  endAll(): void {
    this.endChat();
    for (const s of this.tools.values()) s.end();
    this.tools.clear();
  }

  /** Append to the history, dropping the oldest messages once it exceeds the content cap. */
  private remember(role: string, content: string): void {
    if (!captureContent()) return;
    const max = contentMaxBytes();
    if (content.length > max) {
      content = content.slice(0, max);
      this.historyDropped = true;
    }
    this.history.push({ role, content });
    this.historyBytes += Buffer.byteLength(content);
    while (this.historyBytes > max && this.history.length > 1) {
      this.historyBytes -= Buffer.byteLength(this.history.shift()!.content);
      this.historyDropped = true;
    }
  }

  private outputMessage(m: any): { role: string; content: string; tool_calls?: unknown[] } {
    const calls = Array.isArray(m.content)
      ? m.content
          .filter((b: any) => b && b.type === "toolCall")
          .map((b: any) => ({ id: b.id, name: b.name, arguments: b.arguments }))
      : [];
    return { role: "assistant", content: textOf(m.content), ...(calls.length ? { tool_calls: calls } : {}) };
  }

  /** Value is computed lazily so nothing is built when capture is off. */
  private setContent(span: ReturnType<typeof startChildSpan>, key: string, value: () => string): void {
    if (!captureContent()) return;
    setContentAttribute(span, key, value());
  }

  private endChat(attributes?: Record<string, string | number>, error?: string): void {
    if (!this.chat) return;
    endSpan(this.chat, { ...(attributes ? { attributes } : {}), ...(error ? { error } : {}) });
    this.chat = undefined;
  }
}
