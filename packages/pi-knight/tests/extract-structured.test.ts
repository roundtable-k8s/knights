import test from "node:test";
import assert from "node:assert/strict";
import { extractStructured } from "../src/result-extraction.ts";

const call = (id: string, command: string) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
});
const res = (id: string, text: string, isError = false) => ({
  role: "toolResult", toolCallId: id, content: [{ type: "text", text }], isError,
});
const URL1 = "https://github.com/roundtable-k8s/pi-knight/pull/71";

test("gh pr create yields an opened PR", () => {
  const s = extractStructured(
    [call("1", "git push -u origin rt/67 && gh pr create --title x --body y"), res("1", `Creating...\n${URL1}\n`)],
    "Done, see PR.",
  );
  assert.deepEqual(s.prs, [{ repo: "roundtable-k8s/pi-knight", number: 71, url: URL1, action: "opened" }]);
  assert.equal(s.verdict, undefined);
});

test("gh pr edit yields an updated PR; opened wins for the same PR", () => {
  const s = extractStructured(
    [call("1", "gh pr create -f"), res("1", URL1), call("2", "gh pr edit 71 --body z"), res("2", URL1)],
    "",
  );
  assert.equal(s.prs.length, 1);
  assert.equal(s.prs[0]!.action, "opened");
  const e = extractStructured([call("1", "gh pr edit 71 -R a/b --body z"), res("1", URL1)], "");
  assert.equal(e.prs[0]!.action, "updated");
});

test("failed gh commands are ignored", () => {
  const s = extractStructured([call("1", "gh pr create"), res("1", URL1, true)], "no PR");
  assert.deepEqual(s.prs, []);
});

test("falls back to PR URLs in the final message; push marks them updated", () => {
  const plain = extractStructured([], `Opened ${URL1}`);
  assert.deepEqual(plain.prs, [{ repo: "roundtable-k8s/pi-knight", number: 71, url: URL1 }]);
  const pushed = extractStructured(
    [call("1", "git push origin HEAD"), res("1", "remote: https://github.com/o/r/pull/new/branch")],
    `Pushed fixes to ${URL1}`,
  );
  assert.equal(pushed.prs[0]!.action, "updated");
  assert.equal(pushed.prs.length, 1);
});

test("verdict comes from the final message", () => {
  assert.equal(extractStructured([], "Verdict: needs changes\n...\nVerdict: SHIP IT").verdict, "ship_it");
  assert.equal(extractStructured([], "**Verdict:** Needs-Changes").verdict, "needs_changes");
  assert.equal(extractStructured([], "the verdict was ship it").verdict, undefined);
});

test("gh/git forms pi-knight handled before the move still work", () => {
  // flags before the edit target, #-prefixed number, env prefix
  const e = extractStructured([call("1", "GH_DEBUG=0 gh pr edit -R a/b --body z #7"), res("1", "")], "");
  assert.deepEqual(e.prs, [{ repo: "a/b", number: 7, url: "https://github.com/a/b/pull/7", action: "updated" }]);
  // git with global options before push still marks fallback PRs updated
  const p = extractStructured([call("1", "git -C repo push origin HEAD"), res("1", "ok")], `See ${URL1}`);
  assert.equal(p.prs[0]!.action, "updated");
});

test("stricter PR URL regex: /pull/N/files links are no longer reported (core regex)", () => {
  // pi-knight's old regex reported #71 here; the core's (?![\d/]) skips sub-page links.
  assert.deepEqual(extractStructured([], `Review ${URL1}/files please`).prs, []);
  assert.deepEqual(extractStructured([], `Review ${URL1}.`).prs.map((p) => p.number), [71]);
});
