/** nats_publish's prompt names the knight's real table prefix (set via setNatsPrefix before tools are built). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getNatsTools, setNatsPrefix } from "../src/tools/nats.js";

type WithSnippet = { name: string; promptSnippet?: string; promptGuidelines?: string[] };
const publishSnippet = (): string => {
  const t = getNatsTools().find((x) => x.name === "nats_publish") as unknown as WithSnippet;
  return [t.promptSnippet ?? "", ...(t.promptGuidelines ?? [])].join("\n");
};

test("nats_publish prompt embeds the table prefix set at startup", () => {
  setNatsPrefix("rt-dev");
  const snippet = publishSnippet();
  assert.match(snippet, /rt-dev\.alerts\.<type>/);
  assert.match(snippet, /rt-dev\.reports\.<type>/);
  assert.doesNotMatch(snippet, /startup logs/);
  assert.doesNotMatch(snippet, /SUBSCRIBE_TOPICS/);
  assert.doesNotMatch(snippet, /fleet-a/, "the legacy default prefix must not leak into the prompt");
  assert.match(snippet, /Use your table's prefix \(rt-dev\) in subjects/, "guideline embeds the prefix itself");
});

test("a later prefix change is reflected when the tools are rebuilt", () => {
  setNatsPrefix("rt-prod");
  assert.match(publishSnippet(), /rt-prod\.alerts\.<type>/);
  assert.doesNotMatch(publishSnippet(), /rt-dev\./);
});
