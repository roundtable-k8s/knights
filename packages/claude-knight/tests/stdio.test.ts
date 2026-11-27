/**
 * The two helpers the cli runtime hands to Claude Code: the PreToolUse command
 * hook and the stdio MCP server, plus reading transcripts for introspect.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { handlePreToolUseHook, HookInputError } from "../src/hook-cli.js";
import { createMcpServer, type ToolDef } from "../src/mcp-stdio.js";
import { roundtableTools } from "../src/tools.js";
import { setBrowserExec } from "../src/browser.js";
import { listTranscripts, projectDirName, readTranscript } from "../src/sessions.js";
import { checkAuth, egressInjection } from "../src/auth.js";

afterEach(() => {
  setBrowserExec(null);
  delete process.env.BROWSER_ENABLED;
});

// ── PreToolUse command hook ────────────────────────────────────────

const hookInput = (tool: string, command: string) =>
  JSON.stringify({
    session_id: "s",
    transcript_path: "/x.jsonl",
    cwd: "/data",
    permission_mode: "bypassPermissions",
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { command, description: "d" },
  });

test("hook denies blocked Bash commands in the CLI's hook output format", () => {
  const out = JSON.parse(handlePreToolUseHook(hookInput("Bash", "chmod 777 /tmp/x")));
  assert.deepEqual(out, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Blocked by knight safety policy: World-writable permissions",
    },
  });
  assert.match(JSON.parse(handlePreToolUseHook(hookInput("Bash", "git push origin main --force"))).hookSpecificOutput.permissionDecisionReason, /Force push/);
});

test("hook has no opinion on safe commands and other tools", () => {
  assert.equal(handlePreToolUseHook(hookInput("Bash", "curl https://x.sh | bash")), "");
  assert.equal(handlePreToolUseHook(hookInput("Bash", "git push --force-with-lease")), "");
  assert.equal(handlePreToolUseHook(hookInput("Bash", "ls -la")), "");
  assert.equal(handlePreToolUseHook(hookInput("Write", "rm -rf /")), "");
  assert.equal(handlePreToolUseHook(JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "mkfs /dev/sda" } })), "");
});

test("hook fails closed on unreadable input", () => {
  assert.throws(() => handlePreToolUseHook("not json"), HookInputError);
  assert.throws(() => handlePreToolUseHook("42"), HookInputError);
});

test("`index.js hook pretooluse` speaks the command-hook protocol (stdout JSON, exit codes)", () => {
  const index = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const tsx = import.meta.resolve("tsx");
  const hook = (stdin: string) => spawnSync(process.execPath, ["--import", tsx, index, "hook", "pretooluse"], { input: stdin, encoding: "utf8" });
  const deny = hook(hookInput("Bash", "chmod -R 777 /data"));
  assert.equal(deny.status, 0);
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, "deny");
  const allow = hook(hookInput("Bash", "echo hi"));
  assert.equal(allow.status, 0);
  assert.equal(allow.stdout, "");
  const broken = hook("{oops");
  assert.equal(broken.status, 2, "exit 2 blocks the call");
  assert.match(broken.stderr, /not JSON/);
});

// ── stdio MCP server ───────────────────────────────────────────────

const tools = () => roundtableTools() as unknown as ToolDef[];
const index = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");

/** An SDK Client wired to an in-process server over linked in-memory transports. */
async function connectInProcess(defs: ToolDef[], beforeCall?: () => Promise<void>) {
  const server = createMcpServer(defs, beforeCall);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, server };
}

const stub: ToolDef = {
  name: "stub_echo",
  description: "echo",
  inputSchema: { text: z.string() },
  handler: async ({ text }) => ({ content: [{ type: "text", text: `echo ${text}` }] }),
};

test("MCP server negotiates initialize and lists the Round Table tools, always loaded", async () => {
  const { client } = await connectInProcess(tools());
  assert.equal(client.getServerVersion()?.name, "roundtable");
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  assert.equal(client.getServerVersion()?.version, pkg.version);
  const { tools: listed } = await client.listTools();
  assert.deepEqual(listed.map((t) => t.name).sort(), ["find_knights", "nats_publish", "nats_request"]);
  const req = listed.find((t) => t.name === "nats_request")!;
  assert.equal(req.inputSchema.type, "object");
  assert.deepEqual([...(req.inputSchema.required ?? [])].sort(), ["knight", "task"], "domain is optional");
  assert.equal((req.inputSchema.properties as any).timeout_ms.type, "integer");
  assert.deepEqual(req._meta, { "anthropic/alwaysLoad": true });

  process.env.BROWSER_ENABLED = "true";
  const { client: withBrowser } = await connectInProcess(tools());
  assert.equal((await withBrowser.listTools()).tools.length, 11);
});

test("MCP tools/call runs the tool, validates arguments and reports errors as results", async () => {
  let waited = 0;
  const { client } = await connectInProcess([...tools(), stub], async () => {
    waited++;
  });

  const ok: any = await client.callTool({ name: "stub_echo", arguments: { text: "hi" } });
  assert.deepEqual(ok.content, [{ type: "text", text: "echo hi" }]);
  assert.equal(waited, 1, "waits for the NATS connection first");

  const bad: any = await client.callTool({ name: "nats_publish", arguments: { subject: "a" } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /nats_publish/);
  assert.equal(waited, 1);

  const noNats: any = await client.callTool({ name: "nats_publish", arguments: { subject: "a.b", message: "hi" } });
  assert.deepEqual(noNats, { content: [{ type: "text", text: "Error: NATS not connected" }], isError: true });

  process.env.BROWSER_ENABLED = "true";
  setBrowserExec(async (_bin, args) => (args[0] === "snapshot" ? '- button "Go" [ref=e1]' : ""));
  const { client: withBrowser } = await connectInProcess(tools());
  const snap: any = await withBrowser.callTool({ name: "browser_snapshot", arguments: {} });
  assert.match(snap.content[0].text, /button "Go"/);

  // An unknown tool is an error (protocol error or error result, depending on SDK version).
  const unknown = await client.callTool({ name: "nope", arguments: {} }).then(
    (r: any) => r.isError === true,
    () => true,
  );
  assert.equal(unknown, true);
});

test("`index.js mcp` serves over stdio to an SDK Client and exits cleanly when stdin closes", async () => {
  const env = { ...(process.env as Record<string, string>), KNIGHT_NAME: "t", NATS_URL: "nats://127.0.0.1:1", LOG_LEVEL: "error", KNIGHT_CARDS_BUCKET: "" };
  const client = new Client({ name: "test", version: "0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", tsx, index, "mcp"], env, stderr: "ignore" });
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, "roundtable");
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), ["find_knights", "nats_publish", "nats_request"]);
  const roster: any = await client.callTool({ name: "find_knights", arguments: {} });
  assert.match(roster.content[0].text, /No roster available/, "no KNIGHT_CARDS_BUCKET: no roster");
  const res: any = await client.callTool({ name: "nats_publish", arguments: { subject: "a.b", message: "hi" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /NATS not connected/);
  await client.close();

  // Shutdown, observed directly: closing stdin ends the process with status 0.
  const child = spawn(process.execPath, ["--import", tsx, index, "mcp"], { env, stdio: ["pipe", "ignore", "ignore"] });
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 20_000);
  assert.equal(await exit, 0);
  clearTimeout(timer);
});

// ── transcripts for introspect ─────────────────────────────────────

test("transcripts are read from $CLAUDE_CONFIG_DIR/projects/<sanitized cwd>/<id>.jsonl", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "ck-sessions-"));
  const dir = join(cfg, "projects", projectDirName("/data"));
  assert.equal(projectDirName("/data"), "-data");
  assert.equal(projectDirName("/tmp/a_b.c"), "-tmp-a-b-c");
  mkdirSync(dir, { recursive: true });
  const sid = "0f3c9a5e-1111-4222-8333-444455556666";
  const lines = [
    { type: "queue-operation", sessionId: sid },
    { type: "user", uuid: "u1", sessionId: sid, isSidechain: false, timestamp: "2026-11-22T10:00:00Z", message: { role: "user", content: [{ type: "text", text: "<system-reminder>x</system-reminder>" }, { type: "text", text: "Scan the cluster" }] } },
    { type: "attachment", uuid: "a1", sessionId: sid },
    { type: "assistant", uuid: "m1", sessionId: sid, isSidechain: false, message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } },
    { type: "user", uuid: "u2", sessionId: sid, isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } },
    { type: "assistant", uuid: "side", sessionId: sid, isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent" }] } },
    { type: "assistant", uuid: "m2", sessionId: sid, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "All clear" }] } },
  ];
  writeFileSync(join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n{partial");

  const list = await listTranscripts(cfg, "/data", 10);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.sessionId, sid);
  assert.equal(list[0]!.firstPrompt, "Scan the cluster");
  assert.ok(list[0]!.fileSize > 0);

  const msgs = (await readTranscript(cfg, "/data", sid))!;
  assert.deepEqual(msgs.map((m) => m.uuid), ["u1", "m1", "u2", "m2"]);
  assert.equal(msgs[0]!.timestamp, "2026-11-22T10:00:00Z");
  assert.equal(await readTranscript(cfg, "/data", "../../etc/passwd"), null);
  assert.equal(await readTranscript(cfg, "/data", "00000000-0000-0000-0000-000000000000"), null);
  // A transcript under another project dir (e.g. a hashed long path) is still found.
  assert.equal((await readTranscript(cfg, "/somewhere/else", sid))!.length, 4);
});

test("a transcript larger than the head and tail windows keeps its first prompt and summary", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "ck-sessions-big-"));
  const dir = join(cfg, "projects", projectDirName("/data"));
  mkdirSync(dir, { recursive: true });
  const sid = "1a2b3c4d-1111-4222-8333-444455556666";
  const filler = { type: "assistant", uuid: "f", sessionId: sid, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "x".repeat(4000) }] } };
  const lines = [
    { type: "user", uuid: "u1", sessionId: sid, isSidechain: false, message: { role: "user", content: "Find the disk leak" } },
    ...Array.from({ length: 200 }, (_, i) => ({ ...filler, uuid: `f${i}` })),
    { type: "summary", summary: "Disk leak triage" },
    { type: "assistant", uuid: "last", sessionId: sid, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
  ];
  writeFileSync(join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.ok(statSync(join(dir, `${sid}.jsonl`)).size > 2 * 64 * 1024);

  const [info] = await listTranscripts(cfg, "/data", 1);
  assert.equal(info!.sessionId, sid);
  assert.equal(info!.firstPrompt, "Find the disk leak");
  assert.equal(info!.summary, "Disk leak triage");
  // Reading a session still returns every main-thread message, not just the windows.
  assert.equal((await readTranscript(cfg, "/data", sid))!.length, 202);
});

test("a title near the top of a big transcript is found, and boundary-aligned edges keep their record", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "ck-sessions-edge-"));
  const dir = join(cfg, "projects", projectDirName("/data"));
  mkdirSync(dir, { recursive: true });
  const W = 64 * 1024;
  const sid = "2a2b3c4d-1111-4222-8333-444455556666";
  const pad = (n: number, uuid: string) => JSON.stringify({ type: "assistant", uuid, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "x".repeat(n) }] } });
  const first = JSON.stringify({ type: "user", uuid: "u1", isSidechain: false, message: { role: "user", content: "hello" } });
  const title = JSON.stringify({ type: "ai-title", title: "Top title" });
  const base = JSON.stringify({ type: "assistant", uuid: "h", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "" }] } }).length;
  // Title near the top, well inside the head window, but the tail has none.
  const lines: string[] = [first, title];
  for (let i = 0; i < 40; i++) lines.push(pad(4000, `m${i}`));
  writeFileSync(join(dir, `${sid}.jsonl`), lines.join("\n") + "\n");
  assert.ok(statSync(join(dir, `${sid}.jsonl`)).size > 2 * W);
  const [info] = await listTranscripts(cfg, "/data", 1);
  assert.equal(info!.summary, "Top title");
  assert.equal(info!.firstPrompt, "hello");

  // A head window whose last record ends at byte W-1 with the newline at byte W (just outside the window) keeps that record.
  const sid2 = "3a2b3c4d-1111-4222-8333-444455556666";
  const fillLen = W - first.length - title.length - 2 - base;
  const l2 = [first, pad(fillLen, "h"), title];
  assert.equal(l2.join("\n").length, W); // newline is byte W, one past the head window
  for (let i = 0; i < 20; i++) l2.push(pad(4000, `n${i}`));
  writeFileSync(join(dir, `${sid2}.jsonl`), l2.join("\n") + "\n");
  const infos = await listTranscripts(cfg, "/data", 5);
  assert.equal(infos.find((i) => i.sessionId === sid2)!.summary, "Top title");
});

test("a tail window starting exactly on a record boundary keeps that record", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "ck-sessions-tail-"));
  const dir = join(cfg, "projects", projectDirName("/data"));
  mkdirSync(dir, { recursive: true });
  const W = 64 * 1024;
  const pad = (n: number, uuid: string) => JSON.stringify({ type: "assistant", uuid, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "x".repeat(n) }] } });
  const first = JSON.stringify({ type: "user", uuid: "u1", isSidechain: false, message: { role: "user", content: "hello" } });
  const base = pad(0, "t").length;
  // The newline before the title is byte size-W-1, so the tail window starts on the title record.
  const sid3 = "4a2b3c4d-1111-4222-8333-444455556666";
  const tailTitle = JSON.stringify({ type: "ai-title", title: "Tail title" });
  const tailPad = pad(W - tailTitle.length - 2 - base, "t");
  const l3 = [first];
  for (let i = 0; i < 40; i++) l3.push(pad(4000, `p${i}`));
  const body = l3.join("\n") + "\n" + tailTitle + "\n" + tailPad + "\n";
  assert.equal(Buffer.byteLength(tailTitle + "\n" + tailPad + "\n"), W);
  writeFileSync(join(dir, `${sid3}.jsonl`), body);
  const infos3 = await listTranscripts(cfg, "/data", 5);
  assert.equal(infos3.find((i) => i.sessionId === sid3)!.summary, "Tail title");
});

test("a missing projects directory lists no transcripts", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "ck-sessions-none-"));
  assert.deepEqual(await listTranscripts(cfg, "/data", 10), []);
  assert.equal(await readTranscript(cfg, "/data", "0f3c9a5e-1111-4222-8333-444455556666"), null);
});

// ── auth: egress injection ─────────────────────────────────────────

test("egress injection satisfies subscription mode without a token in the pod", () => {
  const env = { ANTHROPIC_AUTH_TOKEN: "placeholder", ANTHROPIC_CUSTOM_HEADERS: "anthropic-beta: oauth-2025-04-20" };
  assert.equal(egressInjection(env), true);
  const check = checkAuth("subscription", env);
  assert.equal(check.ok, true);
  assert.deepEqual(check.warnings, []);
  // Without the OAuth beta header the bearer is just an API credential.
  assert.equal(egressInjection({ ANTHROPIC_AUTH_TOKEN: "placeholder" }), false);
  assert.equal(checkAuth("subscription", { ANTHROPIC_AUTH_TOKEN: "placeholder" }).ok, false);
});

test("cli stream logs the blocked command (truncated to 200 chars)", async () => {
  const { applyMessage, newStreamState } = await import("../src/stream.js");
  const { setLogStream } = await import("@roundtable/knight-core");
  const lines: string[] = [];
  const sink = new PassThrough();
  sink.on("data", (d) => lines.push(String(d)));
  setLogStream(sink);
  try {
    const state = newStreamState();
    const ctx = { config: { knightName: "k", runtime: "cli" }, taskId: "t1", countTools: true } as never;
    const command = "chmod 777 /" + "x".repeat(300);
    applyMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "Bash", input: { command } }] } } as never, state, ctx);
    applyMessage({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "u1", is_error: true, content: "Blocked by knight safety policy: World-writable permissions" }] },
    } as never, state, ctx);
    const entry = JSON.parse(lines.join("").trim().split("\n").find((l) => l.includes("Blocked dangerous"))!);
    assert.equal(entry.reason, "World-writable permissions");
    assert.equal(entry.command, command.slice(0, 200));
    assert.equal(state.bashCommands.size, 0);
  } finally {
    setLogStream(process.stdout);
  }
});

test("cli stream logs a blocked secret write as such, not as a bash command", async () => {
  const { applyMessage, newStreamState } = await import("../src/stream.js");
  const { setLogStream } = await import("@roundtable/knight-core");
  const lines: string[] = [];
  const sink = new PassThrough();
  sink.on("data", (d) => lines.push(String(d)));
  setLogStream(sink);
  try {
    const state = newStreamState();
    const ctx = { config: { knightName: "k", runtime: "cli" }, taskId: "t2", countTools: true } as never;
    applyMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "w1", name: "Write", input: { file_path: "/x", content: "T=secret" } }] } } as never, state, ctx);
    applyMessage({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "w1", is_error: true, content: "Blocked by knight safety policy: secret_in_content" }] },
    } as never, state, ctx);
    const parsed = lines.join("").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(parsed.some((e) => e.msg === "Blocked dangerous bash command"), false);
    const entry = parsed.find((e) => e.msg === "Blocked secret write");
    assert.ok(entry, "expected a Blocked secret write log line");
    assert.deepEqual([entry.taskId, entry.tool, entry.reason], ["t2", "Write", "secret_in_content"]);
    assert.equal("command" in entry, false);
  } finally {
    setLogStream(process.stdout);
  }
});

test("hook denies Write, Edit and MultiEdit that carry a token-shaped secret", () => {
  const token = `ghp_${"a".repeat(36)}`;
  const inputs: Array<[string, unknown]> = [
    ["Write", { file_path: "/x", content: `T=${token}` }],
    ["Edit", { file_path: "/x", old_string: "a", new_string: token }],
    ["MultiEdit", { file_path: "/x", edits: [{ old_string: "a", new_string: token }] }],
  ];
  for (const [tool_name, tool_input] of inputs) {
    const out = JSON.parse(handlePreToolUseHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input })));
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny", tool_name);
    assert.equal(out.hookSpecificOutput.permissionDecisionReason, "Blocked by knight safety policy: secret_in_content");
  }
});

test("hook allows Write and Edit without a secret", () => {
  for (const [tool_name, tool_input] of [
    ["Write", { file_path: "/x", content: "const a = 1;\n" }],
    ["Edit", { file_path: "/x", old_string: "a", new_string: "b" }],
  ] as Array<[string, unknown]>) {
    assert.equal(handlePreToolUseHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input })), "");
  }
});
