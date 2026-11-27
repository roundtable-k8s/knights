/** find_knights and nats_request-by-name in pi-knight's NATS tools, over fixture cards. */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { initRoster, resetRoster, type KnightCard } from "@roundtable/knight-core";
import { getNatsTools } from "../src/tools/nats.js";

type Exec = (id: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<{ content: Array<{ text: string }> }>;
const tool = (n: string) => getNatsTools().find((t) => t.name === n) as unknown as { execute: Exec; parameters: { required?: string[] }; promptSnippet?: string };
const run = async (n: string, params: Record<string, unknown>) => (await tool(n).execute("call-1", params)).content[0]!.text;

const card = (name: string, domain: string, suspended = false): KnightCard => ({
  name,
  description: `${name} does ${domain}`,
  skills: [{ id: `${domain}-skill`, description: `${domain} work`, tags: [domain] }],
  roundtable: { knight: name, domain, suspended, readyReplicas: suspended ? 0 : 1 },
});
const CARDS = [card("galahad", "security"), card("percival", "research", true), card("pi-self", "code")];
const useFixture = () => initRoster({}, "pi-self", () => null, { readAll: async () => CARDS });

afterEach(() => resetRoster());

test("find_knights is registered next to nats_request, with a prompt line", () => {
  assert.deepEqual(getNatsTools().map((t) => t.name), ["nats_publish", "nats_request", "find_knights"]);
  assert.match(tool("find_knights").promptSnippet ?? "", /call find_knights/);
  assert.deepEqual([...(tool("nats_request").parameters.required ?? [])].sort(), ["knight", "task"], "domain is optional");
});

test("find_knights filters the cards and excludes the caller", async () => {
  useFixture();
  const all = await run("find_knights", {});
  assert.match(all, /galahad \(domain: security, ready\)/);
  assert.match(all, /percival \(domain: research, suspended\)/);
  assert.doesNotMatch(all, /pi-self/);
  assert.match(await run("find_knights", { domain: "research", includeSuspended: false }), /No knight at your table matches/);
  assert.match(await run("find_knights", { query: "SECURITY work" }), /^1 knight\(s\)[\s\S]*galahad/);
});

test("nats_request by name alone resolves the domain; an unknown name is rejected with the list", async () => {
  useFixture();
  assert.match(await run("nats_request", { knight: "galahad", task: "x" }), /NATS not connected/, "resolved, then needs NATS");
  assert.match(await run("nats_request", { knight: "bors", task: "x" }), /Unknown knight "bors".*Valid names: galahad, percival\./);
});

test("missing env: find_knights has no roster; nats_request needs a domain as today", async () => {
  initRoster({}, "pi-self", () => null);
  assert.match(await run("find_knights", {}), /No roster available/);
  assert.match(await run("nats_request", { knight: "galahad", task: "x" }), /domain is required/);
  assert.match(await run("nats_request", { knight: "galahad", domain: "security", task: "x" }), /NATS not connected/);
});
