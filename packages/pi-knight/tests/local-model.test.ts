import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isLocalModel, resolveModel, contextWindowFromEnv, localBaseUrlFromEnv } from "../src/model.ts";
import { describeSessionFailure, getBestAssistantResult, isDeliverableAssistantText, TOOL_CALLS_AS_TEXT_REASON } from "../src/result-extraction.ts";
import { loadConfig } from "../src/config.ts";

type Reply = { content?: string; toolCall?: { name: string; args: unknown } };

/** Minimal OpenAI-compatible stub streaming chat completions the way Ollama's /v1 does:
 *  a tool call arrives whole in one delta (id + function.name + JSON-string arguments). */
function stubServer(reply: (hasToolResult: boolean) => Reply): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "stub" }] }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const hasToolResult = parsed.messages.some((m: { role: string }) => m.role === "tool");
      const r = reply(hasToolResult);
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "stub", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (r.toolCall) {
        res.write(chunk({ role: "assistant", content: "", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: r.toolCall.name, arguments: JSON.stringify(r.toolCall.args) } }] }, null));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ role: "assistant", content: r.content ?? "" }, null));
        res.write(chunk({}, "stop"));
      }
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1` })),
  );
}

async function runSession(url: string, dir: string, prompt: string) {
  process.env.KNIGHT_MODEL_BASE_URL = url;
  // Only the local endpoint is configured: no hosted-provider key anywhere.
  for (const k of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENROUTER_API_KEY", "OPENAI_API_KEY"]) delete process.env[k];
  const { model, modelRuntime } = await resolveModel("ollama/stub");
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, model, modelRuntime,
    sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory(), resourceLoader,
  });
  await session.prompt(prompt);
  return { session, model };
}

test("local model: task runs end to end against an Ollama-style stub with only a local endpoint configured", async () => {
  const dir = mkdtempSync(join(tmpdir(), "local-model-"));
  writeFileSync(join(dir, "notes.txt"), "the secret is 42");
  const { server, url } = await stubServer((hasToolResult) =>
    hasToolResult ? { content: "The file says: the secret is 42" } : { toolCall: { name: "read", args: { path: join(dir, "notes.txt") } } },
  );
  try {
    const { session, model } = await runSession(url, dir, "read notes.txt");
    try {
      assert.equal(isLocalModel(model), true);
      assert.equal(model.baseUrl, url);
      const toolResults = session.messages.filter((m) => m.role === "toolResult") as any[];
      assert.equal(toolResults.length, 1, "the tool call from the stub ran");
      assert.match(JSON.stringify(toolResults[0].content), /the secret is 42/);
      assert.equal(getBestAssistantResult(session), "The file says: the secret is 42");
      assert.equal(session.getSessionStats().cost, 0);
    } finally {
      session.dispose();
    }
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local model: tool calls emitted as plain text give a clear failure reason, not a silent no-output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "local-model-"));
  const { server, url } = await stubServer(() => ({ content: '{"name":"read","arguments":{"path":"/etc/hostname"}}' }));
  try {
    const { session } = await runSession(url, dir, "read a file");
    try {
      assert.equal(session.messages.some((m) => m.role === "toolResult"), false, "nothing ran");
      // The raw text is only a "suspicious fallback"; executeTask turns it into a failure.
      assert.equal(isDeliverableAssistantText(getBestAssistantResult(session) ?? ""), false);
      assert.equal(describeSessionFailure(session, false), TOOL_CALLS_AS_TEXT_REASON);
    } finally {
      session.dispose();
    }
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("local model env: base URL precedence, context window and request timeout", () => {
  assert.equal(localBaseUrlFromEnv({ KNIGHT_MODEL_BASE_URL: "http://a/v1", OPENAI_BASE_URL: "http://b/v1" }), "http://a/v1");
  assert.equal(localBaseUrlFromEnv({ OPENAI_BASE_URL: "http://b/v1" }), "http://b/v1");
  assert.equal(contextWindowFromEnv({ MODEL_CONTEXT_WINDOW: "8192" }), 8192);
  assert.equal(contextWindowFromEnv({ MODEL_CONTEXT_WINDOW: "8k" }), 131072);
  const env = { KNIGHT_NAME: "k", SUBSCRIBE_TOPICS: "a.>", KNIGHT_MODEL: "ollama/x" } as NodeJS.ProcessEnv;
  assert.equal(loadConfig(env).modelRequestTimeoutMs, 600000);
  assert.equal(loadConfig({ ...env, MODEL_REQUEST_TIMEOUT_MS: "1800000" }).modelRequestTimeoutMs, 1800000);
});

test("isLocalModel is false for hosted providers", () => {
  assert.equal(isLocalModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }), false);
  assert.equal(isLocalModel({ provider: "ollama", baseUrl: "http://ollama-pool.ai.svc:11434/v1" }), true);
});
