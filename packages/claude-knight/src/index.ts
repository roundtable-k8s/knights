/**
 * Entry point. Besides the knight itself, the cli runtime re-invokes this
 * program for two helpers Claude Code spawns per task:
 *
 *   node dist/index.js                   the knight (NATS consumer, health, introspect)
 *   node dist/index.js mcp               Round Table tools as a stdio MCP server
 *   node dist/index.js hook pretooluse   Bash guardrails as a command hook
 *
 * Each mode is imported lazily so the hook starts without loading the knight.
 */
const [mode, arg] = process.argv.slice(2);

function fail(prefix: string, code: number) {
  return (err: unknown) => {
    process.stderr.write(`${prefix}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(code);
  };
}

if (mode === "mcp") {
  import("./mcp-stdio.js")
    .then((m) => m.runMcpServer())
    .then((code) => process.exit(code))
    .catch(fail("claude-knight mcp", 1));
} else if (mode === "hook") {
  import("./hook-cli.js")
    .then((m) => m.runHookCommand(arg))
    .then((code) => process.exit(code))
    // Exit 2 blocks the tool call: a guardrail that crashes fails closed.
    .catch(fail("claude-knight hook", 2));
} else {
  import("./main.js").then((m) => m.main()).catch(fail("Fatal error", 1));
}
