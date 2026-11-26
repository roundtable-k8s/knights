import test from "node:test";
import assert from "node:assert/strict";
import { BLOCKED_BASH_PATTERNS, checkBashCommand, checkWriteContent } from "../src/index.js";

const TOKEN = `ghp_${"a".repeat(36)}`;
const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEsecretbody";

test("checkBashCommand blocks dangerous commands and allows ordinary ones", () => {
  assert.ok(BLOCKED_BASH_PATTERNS.length > 0);
  for (const cmd of ["rm -rf /", "git push -f origin main", "git push --force origin main", "chmod 777 x", "mkfs.ext4 /dev/sdb", "dd if=/dev/zero of=/dev/sda"]) {
    assert.ok(checkBashCommand(cmd), cmd);
  }
  for (const cmd of ["rm -rf ./build", "git push --force-with-lease origin f", "git push origin fix-f", "ls -la"]) {
    assert.equal(checkBashCommand(cmd), undefined, cmd);
  }
});

test("checkBashCommand blocks force pushes however the flags are spelled", () => {
  for (const cmd of [
    "git -C repo push --force",
    "git -C repo push -f",
    "git -c k=v push -f",
    "git push origin +main",
    "git push origin +HEAD:main",
    "git push -uf origin feature",
    "git -C repo push origin feature && git push --force",
  ]) {
    assert.ok(checkBashCommand(cmd), cmd);
  }
  assert.equal(checkBashCommand("git -C repo push --force"), "Force push without lease (use --force-with-lease or new commits)");
  assert.equal(checkBashCommand("git -C repo push -f"), "Force push (use new commits instead)");
  assert.equal(checkBashCommand("git push origin +main"), "Force push (use new commits instead)");
});

test("checkBashCommand allows ordinary and lease-protected pushes", () => {
  for (const cmd of [
    "git push --force-with-lease origin feature",
    "git push origin feature",
    "git -C repo push origin feature",
    "git -C repo status -f",
    "git push origin main && git status -f",
    "git push origin feature-f",
  ]) {
    assert.equal(checkBashCommand(cmd), undefined, cmd);
  }
});

test("checkBashCommand blocks root deletes with split or reordered rm flags", () => {
  for (const cmd of ["rm -r -f /", "rm --recursive --force /", "rm -rf --no-preserve-root /", "rm -fr /*", "rm -R -f /"]) {
    assert.equal(checkBashCommand(cmd), "Recursive delete at root level", cmd);
  }
});

test("checkBashCommand allows non-root and non-recursive deletes", () => {
  for (const cmd of ["rm -rf /tmp/x", "rm -f /", "rm -r ./build", "rm -rf ./build", "rm file.txt"]) {
    assert.equal(checkBashCommand(cmd), undefined, cmd);
  }
});

test("checkWriteContent blocks token-shaped secrets in Write, Edit and MultiEdit", () => {
  assert.equal(checkWriteContent("Write", { file_path: "a", content: `x=${TOKEN}` }), "secret_in_content");
  assert.equal(checkWriteContent("Write", { file_path: "a", content: PEM }), "secret_in_content");
  assert.equal(checkWriteContent("Edit", { file_path: "a", old_string: "o", new_string: TOKEN }), "secret_in_content");
  assert.equal(
    checkWriteContent("MultiEdit", { file_path: "a", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: TOKEN }] }),
    "secret_in_content",
  );
});

test("checkWriteContent allows ordinary code and other tools", () => {
  assert.equal(checkWriteContent("Write", { content: "const password = process.env.PASSWORD;\n" }), undefined);
  assert.equal(checkWriteContent("Edit", { old_string: TOKEN, new_string: "redacted" }), undefined);
  assert.equal(checkWriteContent("MultiEdit", { edits: [{ new_string: "ok" }] }), undefined);
  assert.equal(checkWriteContent("MultiEdit", {}), undefined);
  assert.equal(checkWriteContent("Read", { content: TOKEN }), undefined);
  assert.equal(checkWriteContent("Write", undefined), undefined);
});

test("checkWriteContent understands pi write and edit (both edit shapes)", () => {
  assert.equal(checkWriteContent("write", { path: "a", content: `x=${TOKEN}` }), "secret_in_content");
  assert.equal(checkWriteContent("edit", { path: "a", edits: [{ oldText: "a", newText: "b" }, { oldText: "c", newText: TOKEN }] }), "secret_in_content");
  assert.equal(checkWriteContent("edit", { path: "a", oldText: "o", newText: TOKEN }), "secret_in_content");
  assert.equal(checkWriteContent("edit", { path: "a", edits: [{ oldText: TOKEN, newText: "redacted" }] }), undefined);
  assert.equal(checkWriteContent("edit", { path: "a", oldText: "o", newText: "plain" }), undefined);
  assert.equal(checkWriteContent("edit", { path: "a", edits: [null, {}] }), undefined);
  assert.equal(checkWriteContent("write", { path: "a", content: "hello" }), undefined);
});
