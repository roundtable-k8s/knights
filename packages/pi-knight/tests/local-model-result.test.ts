import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.KNIGHT_WORK_ROOT = mkdtempSync(join(tmpdir(), "pk-work-"));
process.env.KNIGHT_DATA_DIR = mkdtempSync(join(tmpdir(), "pk-data-"));
const { executeTask, __setSessionFactoryForTests } = await import("../src/knight.ts");
const { buildResultPayload } = await import("../src/task-payload.ts");
const { TOOL_CALLS_AS_TEXT_REASON, LOCAL_NO_TOOL_CALLS_REASON } = await import("../src/result-extraction.ts");

const config = { knightName: "t", knightModel: "ollama/stub", sessionRetentionMaxFiles: 0, sessionRetentionDays: 0 } as any;

function fake(provider: string, assistant: string, cost: number) {
  const messages: any[] = [];
  let spent = 0;
  return {
    messages,
    dispose() {},
    abort() {},
    sessionManager: { getSessionFile: () => "/nonexistent/s.jsonl" },
    model: { id: "stub", provider, baseUrl: "http://ollama-pool.ai.svc:11434/v1" } as any,
    setModel: async () => {},
    getSessionStats: () => ({ sessionId: "s", totalMessages: messages.length, cost: spent, toolCalls: 0, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
    getLastAssistantText: () => assistant,
    prompt: async () => {
      spent = cost;
      messages.push({ role: "assistant", content: assistant ? [{ type: "text", text: assistant }] : [], stopReason: "stop" });
    },
  } as any;
}

test("local model results: billing local, cost 0, and clear failure when no tool call ran", async () => {
  __setSessionFactoryForTests(async () => fake("ollama", "", 0.5));
  const empty = await executeTask("t1", config);
  assert.equal(empty.success, false);
  assert.equal(empty.billing, "local");
  assert.equal(empty.cost, 0);
  assert.equal(empty.error, LOCAL_NO_TOOL_CALLS_REASON);
  assert.equal(buildResultPayload(empty, { taskId: "t1", knight: "t", durationMs: 1 }).billing, "local");

  __setSessionFactoryForTests(async () => fake("ollama", '{"name":"read","arguments":{"path":"x"}}', 0));
  const asText = await executeTask("t2", config);
  assert.equal(asText.success, false);
  assert.equal(asText.error, TOOL_CALLS_AS_TEXT_REASON);
});

test("hosted model results carry no billing field and keep their cost", async () => {
  __setSessionFactoryForTests(async () => fake("openrouter", "all done", 0.25));
  const r = await executeTask("t3", { ...config, knightModel: "openrouter/x/y" });
  assert.equal(r.success, true);
  assert.equal(r.billing, undefined);
  assert.equal(r.cost, 0.25);
});
