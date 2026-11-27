import { test } from "node:test";
import assert from "node:assert/strict";
import { skillFromToolCall } from "../src/skill-activation.ts";

const f = (tool: string, p: unknown) => skillFromToolCall("/skills", tool, { path: p });

test("a read of <skillsDir>/<category>/<skill>/SKILL.md matches", () => {
  assert.deepEqual(f("read", "/skills/dev/review/SKILL.md"), { category: "dev", skill: "review" });
  assert.deepEqual(f("read", "/skills//dev/./review/SKILL.md"), { category: "dev", skill: "review" });
  assert.deepEqual(skillFromToolCall("/skills/", "read", { path: "/skills/dev/review/SKILL.md" }), { category: "dev", skill: "review" });
});

test("other files, tools, locations and traversal do not match", () => {
  assert.equal(f("read", "/skills/dev/review/README.md"), undefined);
  assert.equal(f("read", "/skills/dev/review/skill.md"), undefined);
  assert.equal(f("read", "/skills/dev/SKILL.md"), undefined);
  assert.equal(f("read", "/skills/a/b/c/SKILL.md"), undefined);
  assert.equal(f("read", "/other/dev/review/SKILL.md"), undefined);
  assert.equal(f("read", "/skills-evil/dev/review/SKILL.md"), undefined);
  assert.equal(f("read", "/skills/../etc/dev/SKILL.md"), undefined);
  assert.equal(f("read", "/skills/dev/../../tmp/x/SKILL.md"), undefined);
  assert.equal(f("write", "/skills/dev/review/SKILL.md"), undefined);
  assert.equal(f("read", 5), undefined);
  assert.equal(f("read", ""), undefined);
  assert.equal(skillFromToolCall("/skills", "read", undefined), undefined);
});
