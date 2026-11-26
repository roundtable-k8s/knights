import assert from "node:assert/strict";
import { test } from "node:test";
import { prsFromBash } from "@roundtable/knight-core";
import { classifyResult } from "../src/result.js";
import { applyMessage, newStreamState } from "../src/stream.js";

const URL1 = "https://github.com/roundtable-k8s/claude-knight/pull/20";

function streamRun(command: string, output: string, countTools: boolean) {
  const state = newStreamState();
  const ctx = { config: { knightName: "k" } as never, taskId: "t", countTools };
  applyMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "Bash", input: { command } }] } } as never, state, ctx);
  applyMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: output }] } } as never, state, ctx);
  return state;
}

test("stream collects PRs from gh commands in both runtimes", () => {
  for (const countTools of [true, false]) {
    const state = streamRun("gh pr create --fill", URL1, countTools);
    assert.equal(state.prs.length, 1);
    assert.equal(state.prs[0]!.action, "opened");
  }
});

const cfg = { authMode: "subscription", claudeModel: "sonnet" } as never;
const ok = (text: string) => ({ type: "result", subtype: "success", is_error: false, result: text, num_turns: 1, total_cost_usd: 0, usage: {} }) as never;

test("classifyResult: command PRs win over URLs in the message; verdict parsed", () => {
  const prs = prsFromBash("gh pr create", URL1);
  const r = classifyResult({
    result: ok("Opened https://github.com/a/b/pull/99 too.\nVerdict: SHIP IT"),
    lastAssistantText: "", aborted: false, config: cfg, durationMs: 1, prs,
  });
  assert.deepEqual(r.prs, prs);
  assert.equal(r.verdict, "ship_it");
});

test("classifyResult: falls back to message URLs; omits fields when none", () => {
  const a = classifyResult({ result: ok(`Done: ${URL1}`), lastAssistantText: "", aborted: false, config: cfg, durationMs: 1 });
  assert.equal(a.prs?.[0]?.number, 20);
  assert.equal(a.prs?.[0]?.action, undefined);
  const b = classifyResult({ result: ok("Nothing to see"), lastAssistantText: "", aborted: false, config: cfg, durationMs: 1 });
  assert.equal("prs" in b, false);
  assert.equal("verdict" in b, false);
});

test("classifyResult: a final Outcome: failed line records failure, keeping the text", () => {
  const text = "Tried twice.\nOutcome: failed - the filing script rejected the answer";
  const r = classifyResult({ result: ok(text), lastAssistantText: "", aborted: false, config: cfg, durationMs: 1 });
  assert.equal(r.success, false);
  assert.equal(r.error, "the filing script rejected the answer");
  assert.equal(r.result, text);
  const mid = classifyResult({ result: ok("Outcome: failed earlier\nFixed it, all good."), lastAssistantText: "", aborted: false, config: cfg, durationMs: 1 });
  assert.equal(mid.success, true);
  const plain = classifyResult({ result: ok("All done"), lastAssistantText: "", aborted: false, config: cfg, durationMs: 1 });
  assert.equal(plain.success, true);
});

const sysCtx = { config: { knightName: "k" } as never, taskId: "t", countTools: false };
const changed = (tasks: object[]) => ({ type: "system", subtype: "background_tasks_changed", tasks }) as never;

test("background jobs: live set noted on success, ambient ignored, notification clears", () => {
  const state = newStreamState();
  applyMessage(changed([{ task_id: "a", description: "make test" }, { task_id: "b", description: "x".repeat(100) }, { task_id: "w", description: "watch", ambient: true }]), state, sysCtx);
  assert.deepEqual([...state.backgroundTasks.keys()], ["a", "b"]);
  const r = classifyResult({ result: ok("Done."), lastAssistantText: "", aborted: false, config: cfg, durationMs: 1, backgroundTasks: state.backgroundTasks });
  assert.equal(r.success, true);
  assert.equal(r.result.split("\n").pop(), `Note: 2 background job(s) were still running when this turn ended and were stopped: make test; ${"x".repeat(77)}.... Their output is not in this result.`);

  applyMessage({ type: "system", subtype: "task_notification", task_id: "a", status: "completed" } as never, state, sysCtx);
  assert.deepEqual([...state.backgroundTasks.keys()], ["b"]);
  applyMessage(changed([]), state, sysCtx);
  const clean = classifyResult({ result: ok("Done."), lastAssistantText: "", aborted: false, config: cfg, durationMs: 1, backgroundTasks: state.backgroundTasks });
  assert.equal(clean.result, "Done.");
});
