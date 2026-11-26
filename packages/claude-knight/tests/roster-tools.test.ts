/** find_knights and nats_request-by-name in the "roundtable" MCP tools, over fixture cards. */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { initRoster, resetRoster, type KnightCard } from "@roundtable/knight-core";
import { roundtableTools } from "../src/tools.js";
import { startParentRoster } from "../src/parent-roster.js";
import { buildPreamble } from "../src/prompt.js";
import { loadConfig } from "../src/config.js";

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const byName = (n: string) => (roundtableTools() as unknown as Array<{ name: string; handler: Handler }>).find((t) => t.name === n)!;

const card = (name: string, domain: string, suspended = false): KnightCard => ({
  name,
  description: `${name} does ${domain}`,
  skills: [{ id: `${domain}-skill`, description: `${domain} work`, tags: [domain] }],
  roundtable: { knight: name, domain, suspended, readyReplicas: suspended ? 0 : 1 },
});
const CARDS = [card("galahad", "security"), card("percival", "research", true), card("gawain", "code")];

function useFixture() {
  initRoster({}, "gawain", () => null, { readAll: async () => CARDS });
}

afterEach(() => resetRoster());

test("find_knights lists the table from the cards, without the caller", async () => {
  useFixture();
  const all = await byName("find_knights").handler({}, {});
  assert.match(all.content[0]!.text, /galahad \(domain: security, ready\)/);
  assert.match(all.content[0]!.text, /percival \(domain: research, suspended\)/);
  assert.doesNotMatch(all.content[0]!.text, /gawain/);
  const filtered = await byName("find_knights").handler({ skill: "security", includeSuspended: false }, {});
  assert.match(filtered.content[0]!.text, /^1 knight\(s\)/);
});

test("find_knights without the env says no roster", async () => {
  initRoster({}, "gawain", () => null);
  const r = await byName("find_knights").handler({}, {});
  assert.match(r.content[0]!.text, /No roster available/);
  assert.equal(r.isError, undefined);
});

test("nats_request by name alone resolves the domain; an unknown name lists the valid ones", async () => {
  useFixture();
  // Resolved, then stops at the (absent) NATS connection: the lookup happened first.
  const known = await byName("nats_request").handler({ knight: "Galahad", task: "check CVE" }, {});
  assert.match(known.content[0]!.text, /NATS not connected/);
  const unknown = await byName("nats_request").handler({ knight: "bors", task: "check CVE" }, {});
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0]!.text, /Unknown knight "bors".*Valid names: galahad, percival\./);
});

test("nats_request without the env: domain still required, explicit domain behaves as today", async () => {
  initRoster({}, "gawain", () => null);
  const noDomain = await byName("nats_request").handler({ knight: "galahad", task: "x" }, {});
  assert.match(noDomain.content[0]!.text, /domain is required/);
  const withDomain = await byName("nats_request").handler({ knight: "galahad", domain: "security", task: "x" }, {});
  assert.match(withDomain.content[0]!.text, /NATS not connected/);
});

test("the preamble tells the model to call find_knights before delegating", () => {
  const env = { KNIGHT_NAME: "gawain", SUBSCRIBE_TOPICS: "x" } as NodeJS.ProcessEnv;
  const p = buildPreamble(loadConfig(env));
  assert.match(p, /call mcp__roundtable__find_knights/);
});

test("the cli runtime does not start the parent roster; the sdk runtime does", () => {
  const started: string[] = [];
  const fake = ((_env: NodeJS.ProcessEnv, self: string) => {
    started.push(self);
    return { start: async () => {} };
  }) as unknown as typeof initRoster;
  assert.equal(startParentRoster("cli", {}, "gawain", fake), null);
  assert.deepEqual(started, [], "cli: no roster, so no KV watch");
  assert.notEqual(startParentRoster("sdk", {}, "gawain", fake), null);
  assert.deepEqual(started, ["gawain"]);
});
