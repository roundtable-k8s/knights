/**
 * The sdk runtime's callback hooks (buildHooks): the PreToolUse matcher covers the tools the
 * guardrails read, and the deny path returns the shared block reason for a secret write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { BLOCK_REASON_PREFIX, setLogStream } from "@roundtable/knight-core";
import { buildHooks } from "../src/hooks.js";

const signal = new AbortController().signal;
const callOptions = { signal } as never;

function preToolUseMatchers() {
  return (buildHooks().PreToolUse ?? []).filter((m) => m.matcher !== undefined);
}

test("buildHooks registers the PreToolUse guardrail for Bash, Write, Edit and MultiEdit", () => {
  const matchers = preToolUseMatchers();
  assert.equal(matchers.length, 1, "one matcher-scoped PreToolUse entry");
  const re = new RegExp(`^(?:${matchers[0]!.matcher})$`);
  for (const tool of ["Bash", "Write", "Edit", "MultiEdit"]) {
    assert.match(tool, re, `matcher should cover ${tool}`);
  }
  assert.doesNotMatch("Read", re);
});

test("buildHooks PreToolUse denies a Write carrying a token-shaped secret and allows a harmless one", async () => {
  const sink = new PassThrough();
  setLogStream(sink);
  try {
    const [hook] = preToolUseMatchers()[0]!.hooks;
    const token = `ghp_${"a".repeat(36)}`;
    const base = { hook_event_name: "PreToolUse", tool_use_id: "tu1", session_id: "s", transcript_path: "/t", cwd: "/" };

    const denied = (await hook!(
      { ...base, tool_name: "Write", tool_input: { file_path: "/x", content: `T=${token}` } } as never,
      "tu1",
      callOptions,
    )) as { hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(denied.hookSpecificOutput?.permissionDecision, "deny");
    assert.ok(denied.hookSpecificOutput!.permissionDecisionReason.startsWith(BLOCK_REASON_PREFIX));
    assert.equal(denied.hookSpecificOutput!.permissionDecisionReason, `${BLOCK_REASON_PREFIX}secret_in_content`);

    const allowed = await hook!(
      { ...base, tool_name: "Write", tool_input: { file_path: "/x", content: "const a = 1;\n" } } as never,
      "tu1",
      callOptions,
    );
    assert.deepEqual(allowed, {});
  } finally {
    setLogStream(process.stdout);
  }
});
