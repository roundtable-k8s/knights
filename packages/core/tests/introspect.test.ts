import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { NatsConnection } from "nats";
import {
  handleIntrospect,
  introspectRequestFromQuery,
  MAX_HISTORY,
  MAX_SESSION_ENTRIES,
  podSubjectToken,
  startIntrospect,
  type IntrospectOptions,
  type LiveSession,
  type SessionSource,
} from "../src/introspect.ts";

type Entry = { n: number };
const entries = (count: number): Entry[] => Array.from({ length: count }, (_, n) => ({ n }));

function fakeSource(opts: {
  persisted?: Record<string, Entry[]>;
  live?: Record<string, LiveSession<Entry>>;
  active?: LiveSession<Entry> | null;
  withLive?: boolean;
} = {}): SessionSource<Entry> & { listLimits: number[] } {
  const persisted = opts.persisted ?? {};
  const listLimits: number[] = [];
  const src: SessionSource<Entry> & { listLimits: number[] } = {
    listLimits,
    async listSessions(limit) {
      listLimits.push(limit);
      const ids = Object.keys(persisted);
      return { sessions: ids.slice(0, limit).map((id) => ({ id })), total: ids.length };
    },
    async latestSessionId() {
      return Object.keys(persisted)[0] ?? null;
    },
    async readSession(id) {
      return persisted[id] ? { startedAt: "2026-01-01T00:00:00Z", entries: persisted[id]! } : null;
    },
    // Two items per entry, so paging is visibly by entry, not by item.
    itemsForEntry: (e) => [{ id: `${e.n}a` }, { id: `${e.n}b` }],
    inflight: () => [{ taskId: "t1" }],
    runtimeInfo: () => ({ model: "m" }),
  };
  if (opts.withLive !== false && (opts.live || opts.active !== undefined)) {
    src.liveSession = (sel) => (sel ? opts.live?.[sel.runId ?? sel.sessionId ?? ""] ?? null : opts.active ?? null);
  }
  return src;
}

const live = (id: string, count: number): LiveSession<Entry> => ({
  stats: () => ({ sessionId: id }),
  entries: () => entries(count),
  tree: () => [{ id: `${id}-root` }, { id: `${id}-child` }],
});

const options = (source: SessionSource<Entry>): IntrospectOptions<Entry> => ({
  knight: "Kay",
  source,
  identity: { pod: "kay-0", node: "n1" },
});

describe("handleIntrospect", () => {
  it("stamps pod/node on every reply and omits node when unknown", async () => {
    const r = await handleIntrospect({ type: "history" }, options(fakeSource()));
    assert.equal(r.pod, "kay-0");
    assert.equal(r.node, "n1");
    const r2 = await handleIntrospect({ type: "history" }, { ...options(fakeSource()), identity: { pod: "p" } });
    assert.equal("node" in r2, false);
  });

  it("history lists at most MAX_HISTORY sessions with the total", async () => {
    const src = fakeSource({ persisted: { aaa: [], bbb: [] } });
    const r = await handleIntrospect({ type: "history" }, options(src));
    assert.deepEqual(r.sessions, [{ id: "aaa" }, { id: "bbb" }]);
    assert.equal(r.total, 2);
    assert.equal(r.knight, "Kay");
    assert.deepEqual(src.listLimits, [MAX_HISTORY]);
  });

  it("session pages by entry with offset/limit and caps the page size", async () => {
    const src = fakeSource({ persisted: { abc: entries(1000) } });
    const r = await handleIntrospect({ type: "session", id: "abc", limit: 3, offset: 10 }, options(src));
    assert.deepEqual(
      { id: r.id, startedAt: r.startedAt, total: r.total, offset: r.offset, returned: r.returned, hasMore: r.hasMore },
      { id: "abc", startedAt: "2026-01-01T00:00:00Z", total: 1000, offset: 10, returned: 3, hasMore: true },
    );
    assert.deepEqual((r.entries as { id: string }[]).map((e) => e.id), ["10a", "10b", "11a", "11b", "12a", "12b"]);

    const big = await handleIntrospect({ type: "session", id: "abc", limit: 10_000 }, options(src));
    assert.equal(big.returned, MAX_SESSION_ENTRIES);
    const dflt = await handleIntrospect({ type: "session", id: "abc" }, options(src));
    assert.equal(dflt.returned, 200);
    const tail = await handleIntrospect({ type: "session", id: "abc", offset: 999 }, options(src));
    assert.equal(tail.returned, 1);
    assert.equal(tail.hasMore, false);
  });

  it("session rejects bad ids before touching the source and reports unknown ones", async () => {
    const src = fakeSource({ persisted: { abc: [] } });
    let reads = 0;
    const read = src.readSession.bind(src);
    src.readSession = (id) => (reads++, read(id));
    for (const id of [undefined, "", "../etc/passwd", "abc/def"]) {
      const r = await handleIntrospect({ type: "session", id }, options(src));
      assert.equal(r.error, "Invalid or missing session id");
    }
    assert.equal(reads, 0);
    const r = await handleIntrospect({ type: "session", id: "def" }, options(src));
    assert.equal(r.error, "Session not found: def");
  });

  it("stats/recent/tree read the active live session", async () => {
    const src = fakeSource({ active: live("s1", 30) });
    const stats = await handleIntrospect({ type: "stats" }, options(src));
    assert.deepEqual(stats.session, { sessionId: "s1" });
    assert.deepEqual(stats.inflight, [{ taskId: "t1" }]);
    const rt = stats.runtime as Record<string, unknown>;
    assert.equal(rt.activeTasks, 1);
    assert.equal(rt.model, "m");
    assert.equal(typeof rt.uptime, "number");

    const recent = await handleIntrospect({ type: "recent", limit: 2 }, options(src));
    assert.deepEqual((recent.entries as { id: string }[]).map((e) => e.id), ["28a", "28b", "29a", "29b"]);
    assert.equal(recent.total, 30);
    assert.equal(recent.returned, 2);
    const dflt = await handleIntrospect({ type: "recent" }, options(src));
    assert.equal(dflt.returned, 20);

    const tree = await handleIntrospect({ type: "tree" }, options(src));
    assert.deepEqual(tree.nodes, [{ id: "s1-root" }, { id: "s1-child" }]);
    assert.equal(tree.totalNodes, 2);
  });

  it("a runId/sessionId selector picks that live session or errors", async () => {
    const src = fakeSource({ live: { "run-A": live("sa", 1), "sid-B": live("sb", 1) }, active: live("s0", 1) });
    const a = await handleIntrospect({ type: "stats", runId: "run-A" }, options(src));
    assert.deepEqual(a.session, { sessionId: "sa" });
    const b = await handleIntrospect({ type: "tree", sessionId: "sid-B" }, options(src));
    assert.deepEqual(b.nodes, [{ id: "sb-root" }, { id: "sb-child" }]);
    const missing = await handleIntrospect({ type: "recent", runId: "nope" }, options(src));
    assert.match(String(missing.error), /runId nope/);
    assert.equal(missing.pod, "kay-0");
  });

  it("without a live session, stats reports session null plus the source's extras", async () => {
    const plain = await handleIntrospect({ type: "stats" }, options(fakeSource({ active: null })));
    assert.equal(plain.session, null);
    const src = fakeSource();
    src.statsExtras = () => ({ session: { recentTasks: 3 }, tasks: [] });
    const extra = await handleIntrospect({ type: "stats", runId: "ignored" }, options(src));
    assert.deepEqual(extra.session, { recentTasks: 3 });
    assert.deepEqual(extra.tasks, []);
  });

  it("without a live session, recent/tree fall back to the latest persisted session", async () => {
    const src = fakeSource({ persisted: { "aaa-1": entries(5), "bbb-2": entries(1) }, active: null });
    const recent = await handleIntrospect({ type: "recent", limit: 2 }, options(src));
    assert.equal(recent.id, "aaa-1");
    assert.deepEqual((recent.entries as { id: string }[]).map((e) => e.id), ["3a", "3b", "4a", "4b"]);
    assert.equal(recent.total, 5);
    assert.equal(recent.returned, 2);
    const tree = await handleIntrospect({ type: "tree" }, options(src));
    assert.equal(tree.totalNodes, 10);

    const empty = fakeSource();
    assert.deepEqual(
      await handleIntrospect({ type: "recent" }, options(empty)),
      { pod: "kay-0", node: "n1", knight: "Kay", entries: [], total: 0, returned: 0 },
    );
    assert.deepEqual(
      await handleIntrospect({ type: "tree" }, options(empty)),
      { pod: "kay-0", node: "n1", knight: "Kay", nodes: [], totalNodes: 0 },
    );
  });

  it("rejects unknown request types", async () => {
    const r = await handleIntrospect({ type: "bogus" } as never, options(fakeSource()));
    assert.match(String(r.error), /Unknown introspect type: bogus/);
  });
});

describe("introspectRequestFromQuery", () => {
  it("parses the HTTP query", () => {
    assert.deepEqual(introspectRequestFromQuery(new URLSearchParams("")), { type: "stats" });
    assert.deepEqual(
      introspectRequestFromQuery(new URLSearchParams("type=session&id=abc&limit=5&offset=10&runId=r&sessionId=s")),
      { type: "session", id: "abc", limit: 5, offset: 10, runId: "r", sessionId: "s" },
    );
    assert.deepEqual(introspectRequestFromQuery(new URLSearchParams("type=recent&limit=x")), { type: "recent" });
  });
});

describe("startIntrospect", () => {
  function fakeNats() {
    const subs: { subject: string; queue?: string; push: (data: string) => Promise<string> }[] = [];
    const nc = {
      subscribe(subject: string, o?: { queue?: string }) {
        const pending: { data: Uint8Array; respond: (d: Uint8Array) => boolean }[] = [];
        let wake: (() => void) | null = null;
        const iter = {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              while (pending.length) yield pending.shift()!;
              await new Promise<void>((r) => (wake = r));
            }
          },
        };
        subs.push({
          subject,
          queue: o?.queue,
          push: (data) =>
            new Promise<string>((resolve) => {
              pending.push({ data: new TextEncoder().encode(data), respond: (d) => (resolve(new TextDecoder().decode(d)), true) });
              wake?.();
            }),
        });
        return iter;
      },
    };
    return { nc: nc as unknown as NatsConnection, subs };
  }

  it("returns null when NATS is not connected", () => {
    assert.equal(startIntrospect({ ...options(fakeSource()), prefix: "rt", nc: null }), null);
  });

  it("subscribes the knight subject in queue group introspect plus the per-pod subject, and answers", async () => {
    const { nc, subs } = fakeNats();
    const src = fakeSource({ persisted: { abc: entries(2) } });
    const started = startIntrospect({ ...options(src), identity: { pod: "kay.0" }, prefix: "rt-dev", nc });
    assert.equal(started?.length, 2);
    assert.deepEqual(subs.map((s) => [s.subject, s.queue]), [
      ["rt-dev.introspect.Kay", "introspect"],
      ["rt-dev.introspect.Kay.kay_0", undefined],
    ]);

    const history = JSON.parse(await subs[0]!.push(JSON.stringify({ type: "history" })));
    assert.deepEqual(history, { pod: "kay.0", knight: "Kay", sessions: [{ id: "abc" }], total: 1 });
    // Not JSON: treated as stats.
    const stats = JSON.parse(await subs[1]!.push("garbage"));
    assert.equal(stats.session, null);
    assert.equal(stats.pod, "kay.0");

    src.listSessions = async () => {
      throw new Error("disk gone");
    };
    const failed = JSON.parse(await subs[1]!.push(JSON.stringify({ type: "history" })));
    assert.deepEqual(failed, { pod: "kay.0", error: "disk gone" });
  });

  it("podSubjectToken keeps NATS-safe names and replaces the rest", () => {
    assert.equal(podSubjectToken("pi-knight-gawain-7d9f-x2"), "pi-knight-gawain-7d9f-x2");
    assert.equal(podSubjectToken("a.b*c>d"), "a_b_c_d");
  });
});
