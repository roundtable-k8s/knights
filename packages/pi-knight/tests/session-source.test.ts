import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleIntrospect } from "@roundtable/knight-core";
import { flattenTree, piSessionSource } from "../src/session-source.ts";

const OLD = "11111111-1111-1111-1111-111111111111";
const NEW = "22222222-2222-2222-2222-222222222222";

async function sessionsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pk-sessions-"));
  const dir = join(root, "--data-work--");
  await mkdir(dir);
  const write = async (id: string, prompt: string, mtime: number) => {
    const file = join(dir, `2026-07-08T06-05-35Z_${id}.jsonl`);
    const lines = [
      { type: "session", id, timestamp: "2026-07-08T06:05:35Z" },
      { id: "e1", parentId: null, type: "message", timestamp: "2026-07-08T06:05:36Z", message: { role: "user", content: prompt } },
      { id: "e2", parentId: "e1", type: "message", timestamp: "2026-07-08T06:05:37Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    ];
    await writeFile(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    await utimes(file, mtime, mtime);
  };
  await write(OLD, "old prompt", 1_000);
  await write(NEW, "new prompt", 2_000);
  return root;
}

const opts = (root: string) => ({
  knight: "Kay",
  source: piSessionSource({ knightModel: "x/y" }, root),
  identity: { pod: "kay-0" },
});

test("pi session source: history and session read the persisted pi session files", async () => {
  const root = await sessionsRoot();
  const history: any = await handleIntrospect({ type: "history" }, opts(root));
  assert.equal(history.total, 2);
  assert.deepEqual(history.sessions.map((s: any) => [s.id, s.firstPrompt]), [[NEW, "new prompt"], [OLD, "old prompt"]]);

  const session: any = await handleIntrospect({ type: "session", id: OLD }, opts(root));
  assert.equal(session.startedAt, "2026-07-08T06:05:35Z");
  assert.equal(session.total, 2);
  assert.deepEqual(session.entries.map((e: any) => e.text), ["old prompt", "ok"]);
});

test("pi session source: with no live session, recent shows the newest session file", async () => {
  const root = await sessionsRoot();
  const recent: any = await handleIntrospect({ type: "recent", limit: 1 }, opts(root));
  assert.equal(recent.id, NEW);
  assert.equal(recent.total, 2);
  assert.deepEqual(recent.entries.map((e: any) => e.text), ["ok"]);
  const stats: any = await handleIntrospect({ type: "stats" }, opts(root));
  assert.equal(stats.session, null);
  assert.equal(stats.runtime.model, "x/y");
});

test("flattenTree walks depth-first and summarizes each node", () => {
  const msg = (id: string, text: string) => ({ id, parentId: null, type: "message", timestamp: "t", message: { role: "user", content: text } });
  const nodes = flattenTree([
    { entry: msg("a", "root"), label: "start", children: [{ entry: msg("b", "child"), children: [] }] },
    { entry: { id: "c", parentId: null, type: "compaction", timestamp: "t" }, children: [] },
  ]);
  assert.deepEqual(nodes.map((n) => [n.id, n.childrenCount, n.label]), [["a", 1, "start"], ["b", 0, undefined], ["c", 0, undefined]]);
  assert.equal(nodes[2]!.summary, "compaction");
});
