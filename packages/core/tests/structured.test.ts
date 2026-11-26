import assert from "node:assert/strict";
import { test } from "node:test";
import { isPrCommand, mergePrs, normalizeVerdict, parseTaskFailure, parseVerdict, prsFromBash, prsFromText, resolvePrs } from "../src/structured.js";

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


test("parseVerdict: tolerant formatting; normalizeVerdict", () => {
  assert.equal(parseVerdict("**Verdict:** Needs-Changes"), "needs_changes");
  assert.equal(parseVerdict("the verdict was ship it"), undefined);
  assert.equal(normalizeVerdict(" Ship-It "), "ship_it");
  assert.equal(normalizeVerdict("maybe"), undefined);
});

test("prsFromBash: gh pr edit target after flags, #-prefixed or --repo=", () => {
  const want = [{ repo: "a/b", number: 7, url: "https://github.com/a/b/pull/7", action: "updated" }];
  assert.deepEqual(prsFromBash("gh pr edit -R a/b --body z #7", ""), want);
  assert.deepEqual(prsFromBash("gh pr edit --repo=a/b 7 --title t", ""), want);
  assert.deepEqual(prsFromBash("gh pr edit 7 -R a/b", ""), want);
});

test("git push with global options; isPrCommand", () => {
  assert.equal(prsFromBash("git -C repo push", "remote: https://github.com/a/b/pull/9")[0]?.action, "updated");
  assert.ok(isPrCommand("git --no-pager push origin HEAD"));
  assert.ok(isPrCommand("gh pr create --fill"));
  assert.ok(!isPrCommand("git status && gh pr view 3"));
});

test("PR URL regex ignores /pull/N/<subpage> and longer numbers", () => {
  assert.deepEqual(prsFromText(`${URL1}/files ${URL1}/commits`), []);
  assert.deepEqual(prsFromText("https://github.com/a/b/pull/12x").map((p) => p.number), [12]);
});

test("resolvePrs: command PRs win, else message URLs", () => {
  const cmd = prsFromBash("gh pr create", URL1);
  assert.equal(resolvePrs(cmd, "https://github.com/a/b/pull/3"), cmd);
  assert.deepEqual(resolvePrs([], "https://github.com/a/b/pull/3").map((p) => p.number), [3]);
});

test("parseTaskFailure: only a final Outcome: failed line matches", () => {
  assert.equal(parseTaskFailure("Outcome: failed - the filing script rejected the answer"), "the filing script rejected the answer");
  assert.equal(parseTaskFailure("tried\n\n**Outcome:** FAILED: bad json\n\n"), "bad json");
  assert.equal(parseTaskFailure("> outcome = failed because x"), "because x");
  assert.equal(parseTaskFailure("work\nOutcome: failed"), "Outcome: failed");
  assert.equal(parseTaskFailure("Outcome: failed\nbut then I fixed it"), undefined);
  assert.equal(parseTaskFailure("The Outcome: failed line is a convention"), undefined);
  assert.equal(parseTaskFailure("Outcome: failedover"), undefined);
  assert.equal(parseTaskFailure("Outcome: succeeded"), undefined);
  assert.equal(parseTaskFailure(""), undefined);
});
