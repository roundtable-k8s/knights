/**
 * `node dist/index.js mcp` — the Round Table tools (nats_request, nats_publish,
 * browser_*) as a stdio MCP server, for the cli runtime. Claude Code starts one
 * per task from the generated --mcp-config. The tools are the same definitions
 * the sdk runtime serves in process (tools.ts, browser.ts); this file only
 * registers them on an @modelcontextprotocol/sdk McpServer over a stdio
 * transport. Logs go to stderr.
 *
 * The process opens its own NATS connection from the env the knight passes
 * down (NATS_URL, KNIGHT_NAME, NATS_RESULTS_PREFIX).
 */
import { createRequire } from "node:module";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { roundtableTools, configureTools } from "./tools.js";
import { connectNats, drain, initLogger, log, setLogStream } from "@roundtable/knight-core";

// dist/mcp-stdio.js and src/mcp-stdio.ts both sit one level below package.json.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** The fields of an SDK tool definition (tool() from the Agent SDK) this server needs. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler: (args: any, extra: unknown) => Promise<{ content: unknown[]; isError?: boolean }>;
}

/**
 * Build the MCP server over a tool set. `beforeCall` lets the server wait for
 * its NATS connection before a tool runs.
 */
export function createMcpServer(tools: ToolDef[], beforeCall: () => Promise<void> = async () => {}): McpServer {
  const server = new McpServer({ name: "roundtable", version });
  for (const t of tools) {
    server.registerTool(
      t.name,
      {
        description: t.description,
        inputSchema: t.inputSchema,
        // Keep these in the prompt instead of behind tool search (same as the sdk runtime's alwaysLoad).
        _meta: { "anthropic/alwaysLoad": true },
      },
      async (args: any) => {
        await beforeCall();
        // A throwing handler becomes an isError result via the SDK.
        return (await t.handler(args, {})) as any;
      },
    );
  }
  return server;
}

export async function runMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  setLogStream(process.stderr);
  const knightName = env["KNIGHT_NAME"] ?? "unknown";
  initLogger(knightName, env["LOG_LEVEL"] ?? "info", env["ROUNDTABLE_TABLE"]);
  configureTools(knightName, env["NATS_RESULTS_PREFIX"] ?? "fleet-a.results");

  const natsUrl = env["NATS_URL"] ?? "nats://nats.database.svc.cluster.local:4222";
  // Connect in the background so initialize/tools/list answer at once; tool
  // calls wait for the connection (bounded), then report "NATS not connected".
  const connected = connectNats({ natsUrl, knightName }, `claude-knight-${knightName}-mcp`).catch((e) =>
    log.warn("MCP server could not connect to NATS", { error: String(e) }),
  );
  const beforeCall = () =>
    Promise.race([connected, new Promise<void>((r) => setTimeout(r, 10_000).unref())]).then(() => undefined);

  const server = createMcpServer(roundtableTools() as unknown as ToolDef[], beforeCall);
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
  await server.connect(new StdioServerTransport());
  // The SDK transport does not watch for end of input; close when the client hangs up.
  process.stdin.once("end", () => void server.close());
  await closed;
  await drain().catch(() => {});
  return 0;
}
