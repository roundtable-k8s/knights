import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyResult } from "../src/result.js";
import { applyMessage, newStreamState } from "../src/stream.js";
import { mergePrs, parseVerdict, prsFromBash, prsFromText } from "../src/structured.js";

const URL1 = "https://github.com/roundtable-k8s/claude-knight/pull/20";

test("parseVerdict: last Verdict line wins, spellings normalised", () => {
  assert.equal(parseVerdict("Verdict: SHIP IT"), "ship_it");
  assert.equal(parseVerdict("review\n**Verdict:** needs changes\n"), "needs_changes");
  assert.equal(parseVerdict("Verdict: needs-changes\nVerdict: ship it"), "ship_it");
  assert.equal(parseVerdict("I would not say verdict: ship it inline"), undefined);
  assert.equal(parseVerdict("no verdict here"), undefined);
});

test("prsFromBash: gh pr create is opened, gh pr edit is updated", () => {
  assert.deepEqual(prsFromBash("gh pr create --title x --body y", `Creating pull request\n${URL1}\n`), [
    { repo: "roundtable-k8s/claude-knight", number: 20, url: URL1, action: "opened" },
  ]);
  assert.deepEqual(prsFromBash("cd r && gh pr edit 20 --body z", URL1), [
    { repo: "roundtable-k8s/claude-knight", number: 20, url: URL1, action: "updated" },
  ]);
  assert.deepEqual(prsFromBash("gh pr edit 7 -R a/b --title t", "")[0], {
    repo: "a/b", number: 7, url: "https://github.com/a/b/pull/7", action: "updated",
  });
  assert.deepEqual(prsFromBash("gh pr create", "error"), []);
});

test("prsFromBash: git push only counts when output names an existing PR", () => {
  assert.deepEqual(prsFromBash("git push -u origin rt/20-x", "remote: https://github.com/a/b/pull/new/rt/20-x"), []);
  assert.equal(prsFromBash("git push", "remote: https://github.com/a/b/pull/9")[0]?.action, "updated");
});

test("mergePrs never downgrades opened to updated", () => {
  const prs = prsFromBash("gh pr create", URL1);
  mergePrs(prs, prsFromBash("gh pr edit 20", URL1));
  mergePrs(prs, prsFromBash("git push", URL1));
  assert.equal(prs.length, 1);
  assert.equal(prs[0]!.action, "opened");
});

test("prsFromText dedupes URLs and sets no action", () => {
  const got = prsFromText(`PR: ${URL1} and again ${URL1}/files, plus https://github.com/a/b/pull/3.`);
  assert.deepEqual(got.map((p) => `${p.repo}#${p.number}`), ["roundtable-k8s/claude-knight#20", "a/b#3"]);
  assert.ok(got.every((p) => p.action === undefined));
});

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
