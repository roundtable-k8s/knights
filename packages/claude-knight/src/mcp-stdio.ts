/**
 * `node dist/index.js mcp` — the Round Table tools (nats_request, nats_publish,
 * browser_*) as a stdio MCP server, for the cli runtime. Claude Code starts one
 * per task from the generated --mcp-config. The tools are the same definitions
 * the sdk runtime serves in process (tools.ts, browser.ts); this file only
 * speaks the protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout, with
 * initialize, ping, tools/list and tools/call. Logs go to stderr.
 *
 * The process opens its own NATS connection from the env the knight passes
 * down (NATS_URL, KNIGHT_NAME, NATS_RESULTS_PREFIX).
 */
import { createInterface } from "node:readline";
import { z } from "zod";
import { roundtableTools, configureTools } from "./tools.js";
import { connectNats, drain } from "./nats.js";
import { initLogger, log, setLogStream } from "./logger.js";

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "roundtable", version: "0.1.0" };

/** The fields of an SDK tool definition (tool() from the Agent SDK) this server needs. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler: (args: any, extra: unknown) => Promise<{ content: unknown[]; isError?: boolean }>;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

export function toolListing(tools: ToolDef[]) {
  return tools.map((t) => {
    const { $schema: _drop, ...schema } = z.toJSONSchema(z.object(t.inputSchema)) as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      inputSchema: schema,
      // Keep these in the prompt instead of behind tool search (same as the sdk runtime's alwaysLoad).
      _meta: { "anthropic/alwaysLoad": true },
    };
  });
}

/**
 * Build a JSON-RPC message handler over a tool set. Returns the response to
 * write, or undefined for notifications. `beforeCall` lets the server wait for
 * its NATS connection before a tool runs.
 */
export function createMcpHandler(getTools: () => ToolDef[], beforeCall: () => Promise<void> = async () => {}) {
  return async (msg: JsonRpcRequest): Promise<JsonRpcResponse | undefined> => {
    const isRequest = msg.id !== undefined && msg.id !== null;
    const id = msg.id ?? null;
    const ok = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
    const err = (code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (!isRequest) return undefined; // notifications (initialized, cancelled, …) need no reply

    switch (msg.method) {
      case "initialize": {
        const requested = msg.params?.protocolVersion;
        const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
        return ok({ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: toolListing(getTools()) });
      case "tools/call": {
        const name = msg.params?.name;
        const tool = getTools().find((t) => t.name === name);
        if (!tool) return err(-32602, `Unknown tool: ${String(name)}`);
        const parsed = z.object(tool.inputSchema).safeParse(msg.params?.arguments ?? {});
        if (!parsed.success) {
          return ok({ content: [{ type: "text", text: `Invalid arguments for ${tool.name}: ${parsed.error.message}` }], isError: true });
        }
        try {
          await beforeCall();
          return ok(await tool.handler(parsed.data, {}));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          return ok({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });
        }
      }
      default:
        return err(-32601, `Method not found: ${String(msg.method)}`);
    }
  };
}

/** Serve the handler over newline-delimited JSON on the given streams. Resolves when input ends. */
export async function serveLines(
  handle: ReturnType<typeof createMcpHandler>,
  input: NodeJS.ReadableStream,
  write: (line: string) => void,
): Promise<void> {
  const pending = new Set<Promise<void>>();
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line);
    } catch {
      write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      continue;
    }
    // Handle concurrently: a nats_request can wait minutes, other calls must not queue behind it.
    const p = handle(msg)
      .then((res) => {
        if (res) write(JSON.stringify(res));
      })
      .catch((e) => log.error("MCP handler failed", { error: String(e) }))
      .finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.allSettled([...pending]);
}

export async function runMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  setLogStream(process.stderr);
  const knightName = env["KNIGHT_NAME"] ?? "unknown";
  initLogger(knightName, env["LOG_LEVEL"] ?? "info");
  configureTools(knightName, env["NATS_RESULTS_PREFIX"] ?? "fleet-a.results");

  const natsUrl = env["NATS_URL"] ?? "nats://nats.database.svc.cluster.local:4222";
  // Connect in the background so initialize/tools/list answer at once; tool
  // calls wait for the connection (bounded), then report "NATS not connected".
  const connected = connectNats({ natsUrl, knightName }, `claude-knight-${knightName}-mcp`).catch((e) =>
    log.warn("MCP server could not connect to NATS", { error: String(e) }),
  );
  const beforeCall = () =>
    Promise.race([connected, new Promise<void>((r) => setTimeout(r, 10_000).unref())]).then(() => undefined);

  await serveLines(createMcpHandler(roundtableTools as unknown as () => ToolDef[], beforeCall), process.stdin, (line) => {
    process.stdout.write(line + "\n");
  });
  await drain().catch(() => {});
  return 0;
}
