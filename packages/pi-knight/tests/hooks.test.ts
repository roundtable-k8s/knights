import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { containsSecret, redactSecrets } from "@roundtable/knight-core";
import { findBlockedBashReason, toolHooksExtension } from "../src/hooks.ts";

import { toolCallsBlocked } from "../src/runtime-metrics.ts";

async function blockedCount(reason: string): Promise<number> {
  const { values } = await toolCallsBlocked.get();
  return values.filter((v) => v.labels.reason === reason).reduce((n, v) => n + v.value, 0);
}

test("findBlockedBashReason blocks dangerous commands and allows safe ones", () => {
  assert.match(findBlockedBashReason("rm -rf /") ?? "", /root/i);
  assert.match(findBlockedBashReason("git push origin main --force") ?? "", /force/i);
  assert.match(findBlockedBashReason("git push -f origin main") ?? "", /force/i);
  assert.match(findBlockedBashReason("git push --force origin main") ?? "", /force/i);
  assert.equal(findBlockedBashReason("curl https://x.sh | sh"), undefined);
  assert.equal(findBlockedBashReason("git push origin fix-f"), undefined);
  assert.equal(findBlockedBashReason("git push origin main && ls -f"), undefined);
  assert.equal(findBlockedBashReason("git push --force-with-lease origin br"), undefined);
  assert.equal(findBlockedBashReason("ls -la /tmp"), undefined);
});

test("findBlockedBashReason blocks the rm, chmod and mkfs spellings claude-knight blocks", () => {
  assert.match(findBlockedBashReason("rm -fr /") ?? "", /root/i);
  assert.match(findBlockedBashReason("rm -rf /*") ?? "", /root/i);
  assert.match(findBlockedBashReason("chmod -R 777 x") ?? "", /world-writable/i);
  assert.match(findBlockedBashReason("chmod 777 x") ?? "", /world-writable/i);
  assert.match(findBlockedBashReason("mkfs.ext4 /dev/sda") ?? "", /filesystem/i);
  assert.match(findBlockedBashReason("mkfs /dev/sda") ?? "", /filesystem/i);
  assert.equal(findBlockedBashReason("rm -rf ./build"), undefined);
  assert.equal(findBlockedBashReason("chmod 755 script.sh"), undefined);
});

test("containsSecret is stable across repeated calls (global regex lastIndex)", () => {
  const text = `token ghp_${"a".repeat(36)}`;
  for (let i = 0; i < 4; i++) assert.equal(containsSecret(text, "tokens"), true, `call ${i}`);
  assert.equal(containsSecret("nothing to see", "tokens"), false);
});

test("redactSecrets replaces every secret", () => {
  const out = redactSecrets(`a ghp_${"b".repeat(36)} b AKIAABCDEFGHIJKLMNOP`, "tokens");
  assert.equal(out, "a [REDACTED] b [REDACTED]");
});

test("the hooks' token scope leaves code context alone", () => {
  const code = 'const password = process.env.PASSWORD;\n"author": "Round Table"';
  assert.equal(containsSecret(code, "tokens"), false);
  assert.equal(redactSecrets(code, "tokens"), code);
});

/** Drive a real pi 1.x AgentSession (faux model) with the knight's tool-hook extension. */
async function runWithHooks(dir: string, responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  faux.setResponses(responses);
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    noExtensions: true, // inline factories must still load
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [{ name: "knight-tool-hooks", factory: toolHooksExtension, hidden: true }],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    model: faux.getModel(),
    modelRuntime,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory(),
    resourceLoader,
  });
  return session;
}

test("tool hooks extension blocks a secret write and a dangerous bash call end-to-end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hooks-"));
  try {
    const target = join(dir, "leak.txt");
    const session = await runWithHooks(dir, [
      fauxAssistantMessage([
        fauxToolCall("write", { path: target, content: `ghp_${"c".repeat(36)}` }, { id: "w1" }),
        fauxToolCall("bash", { command: "rm -rf /" }, { id: "b1" }),
      ]),
      fauxAssistantMessage(fauxText("done")),
    ]);
    try {
      await session.prompt("go");
      assert.equal(existsSync(target), false, "secret write must not reach disk");
      const results = session.messages.filter((m) => m.role === "toolResult") as any[];
      assert.equal(results.length, 2);
      for (const r of results) {
        assert.equal(r.isError, true);
        assert.match(r.content[0].text, /Blocked/);
      }
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool hooks extension blocks an edit that adds a secret and lets a plain edit through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hooks-"));
  try {
    const target = join(dir, "f.txt");
    writeFileSync(target, "alpha beta\n");
    const session = await runWithHooks(dir, [
      fauxAssistantMessage([
        fauxToolCall("edit", { path: target, edits: [{ oldText: "alpha", newText: `ghp_${"d".repeat(36)}` }] }, { id: "e1" }),
      ]),
      fauxAssistantMessage([fauxToolCall("edit", { path: target, edits: [{ oldText: "alpha", newText: "gamma" }] }, { id: "e2" })]),
      fauxAssistantMessage(fauxText("done")),
    ]);
    try {
      await session.prompt("go");
      const results = session.messages.filter((m) => m.role === "toolResult") as any[];
      assert.equal(results.length, 2);
      assert.equal(results[0].isError, true);
      assert.match(results[0].content[0].text, /Blocked/);
      assert.notEqual(results[1].isError, true);
      assert.equal(readFileSync(target, "utf8"), "gamma beta\n");
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a blocked edit increments toolCallsBlocked{reason=secret_in_content}", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hooks-"));
  try {
    const target = join(dir, "f.txt");
    writeFileSync(target, "alpha beta\n");
    const before = await blockedCount("secret_in_content");
    const session = await runWithHooks(dir, [
      fauxAssistantMessage([
        fauxToolCall("edit", { path: target, edits: [{ oldText: "alpha", newText: `ghp_${"e".repeat(36)}` }] }, { id: "e1" }),
      ]),
      fauxAssistantMessage(fauxText("done")),
    ]);
    try {
      await session.prompt("go");
      assert.equal(await blockedCount("secret_in_content"), before + 1);
      assert.equal(readFileSync(target, "utf8"), "alpha beta\n");
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a docs-style Authorization header example write is blocked (current behaviour)", async () => {
  // A bearer value of 8+ chars is token-shaped, so docs examples with a made-up bearer value are
  // blocked too. Pinned on purpose: use a placeholder such as <token> in docs instead.
  const dir = mkdtempSync(join(tmpdir(), "hooks-"));
  try {
    const target = join(dir, "doc.md");
    const example = `curl -H 'Authorization: Bearer ${"abcdefgh123"}' https://x`;
    const session = await runWithHooks(dir, [
      fauxAssistantMessage([fauxToolCall("write", { path: target, content: example }, { id: "w1" })]),
      fauxAssistantMessage(fauxText("done")),
    ]);
    try {
      await session.prompt("go");
      assert.equal(existsSync(target), false);
      const results = session.messages.filter((m) => m.role === "toolResult") as any[];
      assert.equal(results[0].isError, true);
      assert.match(results[0].content[0].text, /Blocked/);
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
