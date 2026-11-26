import { activeTraceContext, endSpan, startChildSpan } from "@roundtable/knight-core";

/**
 * Turns pi session events into `chat <model>` (one per LLM turn) and `execute_tool <tool>`
 * (one per tool call) child spans of the task span. No prompt, response or tool argument text
 * is recorded. With no SDK registered every span is a no-op.
 */
export class SessionSpans {
  private chat?: ReturnType<typeof startChildSpan>;
  private tools = new Map<string, ReturnType<typeof startChildSpan>>();
  private readonly attrs: Record<string, string>;

  constructor(
    private readonly model: string,
    ids: { knight: string; table?: string },
    private readonly parent = activeTraceContext(),
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
        break;
      case "message_end": {
        const m = e.message;
        if (m?.role !== "assistant") break;
        const a: Record<string, string | number> = {};
        if (typeof m.model === "string" && m.model) a["gen_ai.response.model"] = m.model;
        if (Number.isFinite(m.usage?.input)) a["gen_ai.usage.input_tokens"] = m.usage.input;
        if (Number.isFinite(m.usage?.output)) a["gen_ai.usage.output_tokens"] = m.usage.output;
        const failed = m.stopReason === "error" || m.stopReason === "aborted";
        this.endChat(a, failed ? String(m.errorMessage ?? m.stopReason) : undefined);
        break;
      }
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
        break;
      }
      case "tool_execution_end": {
        const id = String(e.toolCallId);
        const span = this.tools.get(id);
        if (!span) break;
        this.tools.delete(id);
        endSpan(span, e.isError ? { error: "tool error" } : {});
        break;
      }
    }
  }

  /** End every span still open (task finished or aborted). Idempotent. */
  endAll(): void {
    this.endChat();
    for (const s of this.tools.values()) s.end();
    this.tools.clear();
  }

  private endChat(attributes?: Record<string, string | number>, error?: string): void {
    if (!this.chat) return;
    endSpan(this.chat, { ...(attributes ? { attributes } : {}), ...(error ? { error } : {}) });
    this.chat = undefined;
  }
}
