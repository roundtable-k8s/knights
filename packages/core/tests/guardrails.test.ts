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
