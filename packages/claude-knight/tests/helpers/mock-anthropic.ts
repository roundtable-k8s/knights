/**
 * A tiny scripted stand-in for the Anthropic Messages API, so tests can drive
 * the real Claude Code binary end to end without a credential. It understands
 * a few directives in the latest user prompt:
 *
 *   RUN_BASH: <command>        → reply with a Bash tool_use
 *   CALL_TOOL: <name> <json>   → reply with a tool_use of that tool
 *   LIST_TOOLS                 → reply with the tool names the request offered
 *   ECHO_SYSTEM <marker>       → reply "system-has-marker: yes|no"
 *   anything else              → reply "pong"
 *
 * After a tool_use, the follow-up request carries a tool_result; the mock
 * answers with "TOOL_RESULT: <text>" so the test can see what the tool returned.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

type Block = { type: string; text?: string; content?: unknown; is_error?: boolean };
type Msg = { role: string; content: string | Block[] };

export interface MockRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export interface MockAnthropic {
  url: string;
  requests: MockRequest[];
  close(): Promise<void>;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Block[])
      .map((b) => (b.type === "text" ? (b.text ?? "") : b.type === "tool_result" ? textOf(b.content) : ""))
      .join("\n");
  }
  return "";
}

function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((b: Block) => b.text ?? "").join("\n");
  return "";
}

type Reply = { kind: "text"; text: string } | { kind: "tool"; name: string; input: unknown };

function decide(body: any): Reply {
  const messages: Msg[] = Array.isArray(body?.messages) ? body.messages : [];
  // Claude Code may append a trailing system-role message (environment details).
  const last = [...messages].reverse().find((m) => m.role === "user");
  const tools: Array<{ name: string }> = Array.isArray(body?.tools) ? body.tools : [];
  if (!last || tools.length === 0) return { kind: "text", text: "pong" };
  const blocks = Array.isArray(last.content) ? last.content : [];
  const toolResult = blocks.find((b) => b.type === "tool_result");
  if (toolResult) {
    return { kind: "text", text: `TOOL_RESULT${toolResult.is_error ? " (error)" : ""}: ${textOf(toolResult.content).slice(0, 2000)}` };
  }
  // The prompt is the last text in the user turn (Claude Code may prepend reminders).
  const prompt = textOf(last.content);
  let m: RegExpMatchArray | null;
  if ((m = prompt.match(/RUN_BASH: (.+)/))) return { kind: "tool", name: "Bash", input: { command: m[1]!.trim(), description: "test" } };
  if ((m = prompt.match(/CALL_TOOL: (\S+) (\{.*\})/))) return { kind: "tool", name: m[1]!, input: JSON.parse(m[2]!) };
  if (/LIST_TOOLS/.test(prompt)) return { kind: "text", text: `TOOLS: ${tools.map((t) => t.name).sort().join(",")}` };
  if ((m = prompt.match(/ECHO_SYSTEM (\S+)/))) {
    return { kind: "text", text: `system-has-marker: ${systemText(body.system).includes(m[1]!) ? "yes" : "no"}` };
  }
  return { kind: "text", text: "pong" };
}

let seq = 0;

function sse(res: http.ServerResponse, model: string, reply: Reply): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const id = `msg_mock_${++seq}`;
  send("message_start", {
    type: "message_start",
    message: {
      id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  });
  if (reply.kind === "text") {
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text } });
  } else {
    send("content_block_start", {
      type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: `toolu_mock_${seq}`, name: reply.name, input: {} },
    });
    send("content_block_delta", {
      type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.input) },
    });
  }
  send("content_block_stop", { type: "content_block_stop", index: 0 });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: reply.kind === "text" ? "end_turn" : "tool_use", stop_sequence: null },
    usage: { output_tokens: 20 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

export async function startMockAnthropic(): Promise<MockAnthropic> {
  const requests: MockRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        // not JSON
      }
      const path = (req.url ?? "/").split("?")[0]!;
      requests.push({ path, headers: req.headers, body });
      if (req.method === "POST" && path === "/v1/messages") {
        const model = body?.model ?? "claude-sonnet-4-6";
        const reply = decide(body);
        if (body?.stream) return sse(res, model, reply);
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({
          id: `msg_mock_${++seq}`, type: "message", role: "assistant", model,
          content: reply.kind === "text" ? [{ type: "text", text: reply.text }] : [{ type: "tool_use", id: `toolu_mock_${seq}`, name: reply.name, input: reply.input }],
          stop_reason: reply.kind === "text" ? "end_turn" : "tool_use", stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }));
      }
      if (path === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ input_tokens: 100 }));
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "mock: not found" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}
