import test from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { spawnSubagentTool, __setSubagentSessionFactoryForTests } from "../src/tools/subagent.js";
import { registry } from "../src/runtime-metrics.js";

type FakeOpts = { promptFails?: boolean; abortRejects?: boolean; inputTokens?: number; hold?: boolean };

function fakeSession(opts: FakeOpts = {}) {
  const calls = { prompt: 0, abort: 0, dispose: 0 };
  let onPromptStarted: () => void = () => {};
  const promptStarted = new Promise<void>((r) => (onPromptStarted = r));
  let finishPrompt: () => void = () => {};
  const promptGate = new Promise<void>((r) => (finishPrompt = r));
  const session = {
    prompt: async (_task: string) => {
      calls.prompt++;
      onPromptStarted();
      if (opts.promptFails) throw new Error("prompt exploded");
      if (opts.hold) await promptGate;
    },
    abort: () => {
      calls.abort++;
      finishPrompt();
      return opts.abortRejects ? Promise.reject(new Error("abort failed")) : Promise.resolve();
    },
    dispose: () => {
      calls.dispose++;
    },
    getLastAssistantText: () => "done",
    getSessionStats: () => ({
      cost: 0.25,
      toolCalls: 0,
      tokens: { input: opts.inputTokens ?? 11, output: 4, cacheRead: 0, cacheWrite: 0 },
    }),
  };
  return { session: session as unknown as AgentSession, calls, promptStarted };
}

function run(signal: AbortSignal | undefined, model?: string) {
  return spawnSubagentTool.execute("call-1", { task: "do it", model }, signal, undefined, undefined as never);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((c) => c.text ?? "").join("");
}

async function tokensLine(model: string, type: string): Promise<string> {
  const text = await registry.metrics();
  return (
    text
      .split("\n")
      .find((l) => l.startsWith("roundtable_knight_llm_tokens_total") && l.includes(`model="${model}"`) && l.includes(`type="${type}"`)) ?? ""
  );
}

test("pre-aborted signal never creates or prompts a session", async () => {
  let created = 0;
  __setSubagentSessionFactoryForTests(async () => {
    created++;
    return { session: fakeSession().session, local: true };
  });
  try {
    const ac = new AbortController();
    ac.abort();
    const result = await run(ac.signal);
    assert.equal(textOf(result), "Sub-agent aborted");
    assert.equal(created, 0);
    assert.equal(getEventListeners(ac.signal, "abort").length, 0);
  } finally {
    __setSubagentSessionFactoryForTests(null);
  }
});

test("abort during session creation stops before prompt and disposes the session", async () => {
  const fake = fakeSession();
  const ac = new AbortController();
  __setSubagentSessionFactoryForTests(async () => {
    ac.abort();
    return { session: fake.session, local: true };
  });
  try {
    const result = await run(ac.signal);
    assert.equal(textOf(result), "Sub-agent aborted");
    assert.equal(fake.calls.prompt, 0);
    assert.equal(fake.calls.dispose, 1);
    assert.equal(getEventListeners(ac.signal, "abort").length, 0);
  } finally {
    __setSubagentSessionFactoryForTests(null);
  }
});

test("abort during prompt calls abort() once and removes the listener", async () => {
  const fake = fakeSession({ hold: true });
  __setSubagentSessionFactoryForTests(async () => ({ session: fake.session, local: false }));
  try {
    const ac = new AbortController();
    const pending = run(ac.signal, "test/abort-during-prompt");
    await fake.promptStarted;
    assert.equal(getEventListeners(ac.signal, "abort").length, 1);
    ac.abort();
    await pending;
    assert.equal(fake.calls.abort, 1);
    assert.equal(fake.calls.dispose, 1);
    assert.equal(getEventListeners(ac.signal, "abort").length, 0);
  } finally {
    __setSubagentSessionFactoryForTests(null);
  }
});

test("a rejecting abort() is caught and does not raise an unhandled rejection", async () => {
  const fake = fakeSession({ abortRejects: true, hold: true });
  __setSubagentSessionFactoryForTests(async () => ({ session: fake.session, local: false }));
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const ac = new AbortController();
    const pending = run(ac.signal);
    await fake.promptStarted;
    ac.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fake.calls.abort, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    __setSubagentSessionFactoryForTests(null);
  }
});

test("usage is recorded once on the abort-during-prompt path", async () => {
  const model = "test/usage-abort-prompt";
  const fake = fakeSession({ hold: true, inputTokens: 53 });
  __setSubagentSessionFactoryForTests(async () => ({ session: fake.session, local: false }));
  try {
    const ac = new AbortController();
    const pending = run(ac.signal, model);
    await fake.promptStarted;
    ac.abort();
    await pending;
    assert.match(await tokensLine(model, "input"), / 53$/);
  } finally {
    __setSubagentSessionFactoryForTests(null);
  }
});

test("the spawn_subagent tool rejects a bare Claude alias with the provider/model hint", async () => {
  __setSubagentSessionFactoryForTests(null); // real factory: resolveModel decides
  const keys = ["KNIGHT_MODEL_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE"];
  const saved = keys.map((k) => process.env[k]);
  for (const k of keys) delete process.env[k];
  try {
    const text = textOf(await run(new AbortController().signal, "sonnet"));
    assert.match(text, /^Sub-agent error: .*is a Claude Code alias; pi-knight needs provider\/model/);
  } finally {
    keys.forEach((k, i) => {
      if (saved[i] !== undefined) process.env[k] = saved[i];
    });
  }
});

test("usage is recorded once when the prompt fails", async () => {
  const model = "test/usage-failed-prompt";
  const fake = fakeSession({ promptFails: true, inputTokens: 37 });
  __setSubagentSessionFactoryForTests(async () => ({ session: fake.session, local: false }));
  try {
    const result = await run(new AbortController().signal, model);
    assert.match(textOf(result), /^Sub-agent error: prompt exploded/);
    assert.match(await tokensLine(model, "input"), / 37$/);
  } finally {
    __setSubagentSessionFactoryForTests(null);
  }
});

test("usage is recorded exactly once on success", async () => {
  const model = "test/usage-success";
  const fake = fakeSession({ inputTokens: 23 });
  __setSubagentSessionFactoryForTests(async () => ({ session: fake.session, local: false }));
  try {
    const result = await run(undefined, model);
    assert.match(textOf(result), /Sub-agent result/);
    assert.match(await tokensLine(model, "input"), / 23$/);
    assert.equal(fake.calls.dispose, 1);
  } finally {
    __setSubagentSessionFactoryForTests(null);
  }
});
