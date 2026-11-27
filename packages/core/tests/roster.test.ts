import { strict as assert } from "node:assert";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it, mock } from "node:test";
import { Writable } from "node:stream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import {
  cardStatus,
  filterKnights,
  findKnightsText,
  formatKnightMatches,
  initRoster,
  natsCardSource,
  NO_ROSTER,
  resetRoster,
  resolveRequestTarget,
  Roster,
  ROSTER_RETRY_MIN_MS,
  rosterConfigFromEnv,
  type CardSource,
  type KnightCard,
} from "../src/roster.ts";
import { cardsBucketFromEnv } from "../src/config.ts";
import { initLogger, setLogStream } from "../src/logger.ts";
import { startKnightService } from "../src/service.ts";

const card = (name: string, domain: string, extra: Partial<KnightCard> = {}, rt: NonNullable<KnightCard["roundtable"]> = {}): KnightCard => ({
  name,
  description: `${name}, ${domain} knight`,
  skills: [],
  ...extra,
  roundtable: { table: "personal", knight: name, domain, phase: "Ready", readyReplicas: 1, suspended: false, ...rt },
});

const FIXTURE: KnightCard[] = [
  card("galahad", "security", {
    description: "Security analyst: CVE triage and the daily security brief.",
    skills: [
      { id: "cve-triage", name: "cve-triage", description: "Triage a CVE against the fleet's images", tags: ["security"] },
      { id: "threat-model", description: "Threat-model a design doc", tags: ["security", "design"] },
    ],
  }),
  card("rt-ui", "frontend", {
    description: "Dashboard specialist.",
    skills: [{ id: "roundtable-ui", description: "Work on the React dashboard", tags: ["frontend"] }],
  }),
  card("percival", "research", { skills: [{ id: "web-search", description: "Search the web", tags: ["research"] }] }, { suspended: true, readyReplicas: 0, phase: "Suspended" }),
  card("tristan", "ops", {}, { readyReplicas: 0, phase: "Pending" }),
  card("Lancelot", "code", { description: "The calling knight" }),
];

const names = (ms: { name: string }[]) => ms.map((m) => m.name);

describe("filterKnights", () => {
  it("lists every other knight, sorted, without the caller (case-insensitive)", () => {
    assert.deepEqual(names(filterKnights(FIXTURE, {}, "lancelot")), ["galahad", "percival", "rt-ui", "tristan"]);
  });

  it("filters by exact domain", () => {
    assert.deepEqual(names(filterKnights(FIXTURE, { domain: "security" }, "lancelot")), ["galahad"]);
    assert.deepEqual(names(filterKnights(FIXTURE, { domain: "secur" }, "lancelot")), []);
  });

  it("filters by skill id or tag and returns only the matching skills", () => {
    const byId = filterKnights(FIXTURE, { skill: "threat-model" }, "lancelot");
    assert.deepEqual(names(byId), ["galahad"]);
    assert.deepEqual(byId[0]!.skills.map((s) => s.id), ["threat-model"]);
    const byTag = filterKnights(FIXTURE, { skill: "Design" }, "lancelot");
    assert.deepEqual(names(byTag), ["galahad"]);
    assert.deepEqual(names(filterKnights(FIXTURE, { skill: "frontend" }, "lancelot")), ["rt-ui"]);
  });

  it("matches the query case-insensitively on name, description and skill descriptions", () => {
    assert.deepEqual(names(filterKnights(FIXTURE, { query: "GALA" }, "lancelot")), ["galahad"]);
    assert.deepEqual(names(filterKnights(FIXTURE, { query: "dashboard" }, "lancelot")), ["rt-ui"]);
    const bySkill = filterKnights(FIXTURE, { query: "search the WEB" }, "lancelot");
    assert.deepEqual(names(bySkill), ["percival"]);
    assert.deepEqual(bySkill[0]!.skills.map((s) => s.id), ["web-search"]);
    assert.deepEqual(names(filterKnights(FIXTURE, { query: "calling" }, "lancelot")), [], "self never matches");
  });

  it("lists suspended knights with their status unless includeSuspended is false", () => {
    const all = filterKnights(FIXTURE, {}, "lancelot");
    assert.equal(all.find((m) => m.name === "percival")!.status, "suspended");
    assert.equal(all.find((m) => m.name === "tristan")!.status, "not ready");
    assert.equal(all.find((m) => m.name === "galahad")!.status, "ready");
    assert.deepEqual(names(filterKnights(FIXTURE, { includeSuspended: false }, "lancelot")), ["galahad", "rt-ui", "tristan"]);
  });

  it("derives the status from suspended, readyReplicas and phase", () => {
    assert.equal(cardStatus({ name: "x" }), "not ready");
    assert.equal(cardStatus({ name: "x", roundtable: { phase: "Ready" } }), "ready");
    assert.equal(cardStatus({ name: "x", roundtable: { readyReplicas: 2, suspended: true } }), "suspended");
  });

  it("formats a compact list", () => {
    const text = formatKnightMatches(filterKnights(FIXTURE, { domain: "security" }, "lancelot").map((m) => ({ ...m, live: true })));
    assert.match(text, /^1 knight\(s\) at your table:/);
    assert.match(text, /- galahad \(domain: security, ready, live\): Security analyst/);
    assert.match(text, / {4}- cve-triage: Triage a CVE/);
    assert.equal(formatKnightMatches([]), "No knight at your table matches.");
  });
});

/** A fake card source: `cards` is the bucket; `watch` reports what was there when it started. */
function fakeSource(cards: KnightCard[], opts: { watch?: boolean; live?: string[] } = {}) {
  const calls = { readAll: 0, ping: 0 };
  let apply: ((k: string, c: KnightCard | null, rev: number) => void) | null = null;
  const source: CardSource = {
    async readAll() {
      calls.readAll++;
      return cards;
    },
    ...(opts.watch
      ? {
          async watch(a, ready) {
            apply = a;
            cards.forEach((c, i) => a(c.name, c, i + 1));
            ready();
            return () => {};
          },
        }
      : {}),
    async ping() {
      calls.ping++;
      return new Set(opts.live ?? []);
    },
  };
  return { source, calls, push: (k: string, c: KnightCard | null, rev: number) => apply!(k, c, rev) };
}

describe("Roster", () => {
  afterEach(() => resetRoster());

  it("reads the cards directly until the watch is up, then serves them from the cache", async () => {
    const { source, calls, push } = fakeSource([...FIXTURE], { watch: true });
    const roster = new Roster({ self: "lancelot", source });
    assert.equal(names(await roster.find({ domain: "security" })).length, 1);
    assert.equal(calls.readAll, 1, "direct read before start()");
    await roster.start();
    assert.equal(roster.cached, true);
    await roster.find({});
    assert.equal(calls.readAll, 1, "no direct read once cached");

    push("bors", card("bors", "security"), 100);
    assert.deepEqual(names(await roster.find({ domain: "security" })), ["bors", "galahad"]);
    push("bors", null, 101);
    push("bors", card("bors", "security"), 50); // stale revision ignored
    assert.deepEqual(names(await roster.find({ domain: "security" })), ["galahad"]);
  });

  it("marks knights live from the PING replies, and only when someone answered", async () => {
    const live = new Roster({ self: "lancelot", source: fakeSource(FIXTURE, { live: ["galahad"] }).source });
    const ms = await live.find({});
    assert.equal(ms.find((m) => m.name === "galahad")!.live, true);
    assert.equal(ms.find((m) => m.name === "rt-ui")!.live, false);
    const silent = new Roster({ self: "lancelot", source: fakeSource(FIXTURE).source });
    assert.equal((await silent.find({})).every((m) => m.live === undefined), true);
  });

  it("nats_request with a name only resolves the domain from the card", async () => {
    initRoster({}, "lancelot", () => null, fakeSource(FIXTURE).source);
    assert.deepEqual(await resolveRequestTarget("Galahad"), { knight: "galahad", domain: "security" });
    assert.deepEqual(await resolveRequestTarget("percival"), { knight: "percival", domain: "research" }, "suspended knights are reachable");
  });

  it("rejects an unknown name and lists the valid names", async () => {
    initRoster({}, "lancelot", () => null, fakeSource(FIXTURE).source);
    const r = await resolveRequestTarget("gawain");
    assert.ok("error" in r);
    assert.match(r.error, /Unknown knight "gawain"/);
    assert.match(r.error, /Valid names: galahad, percival, rt-ui, tristan\./);
    const self = await resolveRequestTarget("lancelot");
    assert.ok("error" in self, "the caller has no card to send to");
  });

  it("keeps an explicit domain without any lookup", async () => {
    const { source, calls } = fakeSource(FIXTURE);
    initRoster({}, "lancelot", () => null, source);
    assert.deepEqual(await resolveRequestTarget("anyone", "ops"), { knight: "anyone", domain: "ops" });
    assert.equal(calls.readAll, 0);
  });

  it("find_knights text: list, or the lookup error", async () => {
    initRoster({}, "lancelot", () => null, fakeSource(FIXTURE).source);
    assert.match((await findKnightsText({ skill: "cve-triage" })).text, /galahad/);
    initRoster({}, "lancelot", () => null, { readAll: async () => { throw new Error("no bucket"); } });
    const r = await findKnightsText({});
    assert.equal(r.isError, true);
    assert.match(r.text, /no bucket/);
  });
});

describe("Roster when the watch ends", () => {
  afterEach(() => {
    resetRoster();
    mock.timers.reset();
    setLogStream(process.stdout);
  });

  /** A source whose watch can be ended by the test; each start() sees the current bucket. */
  function endable(bucket: KnightCard[]) {
    const st = { readAll: 0, watches: 0, stopped: 0, end: (_e?: unknown) => {}, failNext: false };
    const source: CardSource = {
      async readAll() {
        st.readAll++;
        return bucket;
      },
      async watch(apply, ready, ended) {
        st.watches++;
        if (st.failNext) throw new Error("bucket gone");
        bucket.forEach((c, i) => apply(c.name, c, i + 1));
        ready();
        st.end = ended;
        return () => {
          st.stopped++;
        };
      },
    };
    return { source, st };
  }

  it("falls back to readAll() and sees changed cards, then a restart repopulates the cache", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const bucket = [card("galahad", "security")];
    const { source, st } = endable(bucket);
    const roster = new Roster({ self: "lancelot", source });
    await roster.start();
    assert.equal(roster.cached, true);
    assert.deepEqual(names(await roster.find({})), ["galahad"]);
    assert.equal(st.readAll, 0);

    bucket.push(card("bors", "security")); // the cache can no longer see this
    st.end(new Error("connection lost"));
    assert.equal(roster.cached, false);
    assert.deepEqual(names(await roster.find({})), ["bors", "galahad"]);
    assert.equal(st.readAll, 1);

    mock.timers.tick(ROSTER_RETRY_MIN_MS);
    await new Promise((r) => setImmediate(r));
    assert.equal(st.watches, 2);
    assert.equal(roster.cached, true);
    assert.deepEqual(names(await roster.find({})), ["bors", "galahad"]);
    assert.equal(st.readAll, 1, "served from the cache again");
  });

  it("retries with a doubling, capped back-off and stop() cancels the retry", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { source, st } = endable([card("galahad", "security")]);
    const roster = new Roster({ self: "lancelot", source });
    st.failNext = true;
    await roster.start();
    assert.equal(st.watches, 1);
    mock.timers.tick(ROSTER_RETRY_MIN_MS - 1);
    await new Promise((r) => setImmediate(r));
    assert.equal(st.watches, 1);
    mock.timers.tick(1);
    await new Promise((r) => setImmediate(r));
    assert.equal(st.watches, 2, "first retry after 5 s");
    mock.timers.tick(ROSTER_RETRY_MIN_MS * 2);
    await new Promise((r) => setImmediate(r));
    assert.equal(st.watches, 3, "second retry after 10 s");

    roster.stop();
    mock.timers.tick(10 * 60_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(st.watches, 3, "no retry after stop()");
  });

  it("logs the first failed watch at warn and keeps later retries quiet", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const chunks: string[] = [];
    setLogStream(new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } }));
    initLogger("lancelot", "info");
    const { source, st } = endable([card("galahad", "security")]);
    const roster = new Roster({ self: "lancelot", source });
    st.failNext = true;
    await roster.start();
    const warns = () => chunks.join("").split("\n").filter((l) => l.includes('"level":"warn"'));
    assert.equal(warns().length, 1, "the first failure is logged");
    assert.match(warns()[0]!, /Roster watch failed or ended/);
    mock.timers.tick(ROSTER_RETRY_MIN_MS);
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(ROSTER_RETRY_MIN_MS * 2);
    await new Promise((r) => setImmediate(r));
    assert.equal(st.watches, 3, "retries continue");
    assert.equal(warns().length, 1, "later retries are not logged");
    roster.stop();
  });

  it("a stopped-then-restarted roster logs its first failure again, once", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const chunks: string[] = [];
    setLogStream(new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } }));
    initLogger("lancelot", "info");
    const { source, st } = endable([card("galahad", "security")]);
    const roster = new Roster({ self: "lancelot", source });
    const warns = () => chunks.join("").split("\n").filter((l) => l.includes('"level":"warn"'));
    st.failNext = true;
    await roster.start();
    assert.equal(warns().length, 1);
    roster.stop();
    await roster.start();
    assert.equal(warns().length, 2, "the restarted roster logs its first failure");
    mock.timers.tick(ROSTER_RETRY_MIN_MS);
    await new Promise((r) => setImmediate(r));
    assert.equal(warns().length, 2, "retries after the restart stay quiet");
    roster.stop();
  });

  it("stop() while watching does not schedule a retry", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { source, st } = endable([card("galahad", "security")]);
    const roster = new Roster({ self: "lancelot", source });
    await roster.start();
    const end = st.end;
    roster.stop();
    end(); // the iterator ending because of stop()
    mock.timers.tick(10 * 60_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(st.watches, 1);
    assert.equal(st.stopped, 1);
  });
});

describe("cardsBucketFromEnv", () => {
  it("trims and treats blank as unset", () => {
    assert.equal(cardsBucketFromEnv({ KNIGHT_CARDS_BUCKET: " cards " }), "cards");
    assert.equal(cardsBucketFromEnv({ KNIGHT_CARDS_BUCKET: "  " }), undefined);
    assert.equal(cardsBucketFromEnv({}), undefined);
  });
});

describe("missing env (older operator)", () => {
  afterEach(() => resetRoster());

  it("has no roster without KNIGHT_CARDS_BUCKET or ROUNDTABLE_TABLE", () => {
    assert.equal(rosterConfigFromEnv({ ROUNDTABLE_TABLE: "personal" }), null);
    assert.equal(rosterConfigFromEnv({ KNIGHT_CARDS_BUCKET: "roundtable-cards" }), null);
    assert.equal(rosterConfigFromEnv({ KNIGHT_CARDS_BUCKET: "roundtable-cards", ROUNDTABLE_TABLE: "none" }), null);
    assert.deepEqual(rosterConfigFromEnv({ KNIGHT_CARDS_BUCKET: "roundtable-cards", ROUNDTABLE_TABLE: "personal" }), {
      bucket: "roundtable-cards",
      table: "personal",
    });
    assert.equal(initRoster({ ROUNDTABLE_TABLE: "personal" }, "lancelot", () => null), null);
  });

  it("find_knights says no roster; nats_request keeps the explicit domain and needs one", async () => {
    initRoster({}, "lancelot", () => null);
    assert.deepEqual(await findKnightsText({}), { text: NO_ROSTER });
    assert.deepEqual(await resolveRequestTarget("galahad", "security"), { knight: "galahad", domain: "security" });
    const r = await resolveRequestTarget("galahad");
    assert.ok("error" in r);
    assert.match(r.error, /domain is required/);
  });
});

const NATS_BIN = process.env["NATS_SERVER_BIN"] ?? ["/usr/local/bin/nats-server", "/usr/bin/nats-server"].find(existsSync) ?? "nats-server";
const hasBin = (bin: string) => !spawnSync(bin, ["--version"]).error;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("roster against a real nats-server", { skip: !hasBin(NATS_BIN) && "nats-server not found (set NATS_SERVER_BIN)" }, () => {
  let proc: ChildProcess;
  let dir: string;
  let nc: NatsConnection;
  let kv: KV;
  const port = 5400 + Math.floor(Math.random() * 500);

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "nats-kv-"));
    proc = spawn(NATS_BIN, ["-js", "-p", String(port), "-sd", dir], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try { nc = await connect({ servers: `nats://127.0.0.1:${port}` }); break; } catch { await sleep(100); }
    }
    kv = await new Kvm(nc).create("roundtable-cards", { history: 1 });
    for (const c of FIXTURE) await kv.put(`personal.${c.name}`, JSON.stringify(c));
    await kv.put("other.gawain", JSON.stringify(card("gawain", "security")));
  });

  after(async () => {
    resetRoster();
    await nc?.close().catch(() => {});
    proc?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads this table's cards directly, watches changes, and marks live pods from PING", async () => {
    const source = natsCardSource(() => nc, "roundtable-cards", "personal");
    assert.deepEqual((await source.readAll()).map((c) => c.name).sort(), ["Lancelot", "galahad", "percival", "rt-ui", "tristan"]);

    const roster = initRoster({}, "lancelot", () => nc, source)!;
    await roster.start();
    for (let i = 0; i < 50 && !roster.cached; i++) await sleep(20);
    assert.equal(roster.cached, true);
    assert.deepEqual(names(await roster.find({ domain: "security" })), ["galahad"], "other tables are not listed");

    await kv.put("personal.bors", JSON.stringify(card("bors", "security")));
    await kv.delete("personal.galahad");
    for (let i = 0; i < 50; i++) {
      if (names(await roster.find({ domain: "security" })).join() === "bors") break;
      await sleep(20);
    }
    assert.deepEqual(names(await roster.find({ domain: "security" })), ["bors"]);

    const svc = await startKnightService({
      nc, knightName: "rt-ui", table: "personal", domain: "frontend", model: "m", runtime: "test", version: "0.0.0",
      pod: "rt-ui-0", skillsDir: "/nonexistent", maxConcurrentTasks: 1, getActive: () => 0, getCounts: () => ({ total: 0, failed: 0 }),
    });
    try {
      const ms = await roster.find({});
      assert.equal(ms.find((m) => m.name === "rt-ui")!.live, true);
      assert.equal(ms.find((m) => m.name === "bors")!.live, false);
      assert.match((await findKnightsText({ query: "dashboard" })).text, /rt-ui \(domain: frontend, ready, live\)/);
    } finally {
      await svc.stop();
    }
    assert.deepEqual(await resolveRequestTarget("bors"), { knight: "bors", domain: "security" });
  });

  it("an empty table still loads the watch", async () => {
    const roster = new Roster({ self: "x", source: natsCardSource(() => nc, "roundtable-cards", "empty") });
    await roster.start();
    for (let i = 0; i < 50 && !roster.cached; i++) await sleep(20);
    assert.equal(roster.cached, true);
    assert.deepEqual(await roster.find({}), []);
    roster.stop();
  });
});
