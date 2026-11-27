/**
 * The table roster: the agent cards the RoundTable controller writes to NATS KV
 * (bucket KNIGHT_CARDS_BUCKET, key `<table>.<knight>`, schema in roundtable
 * docs/agent-cards.md). Backs the `find_knights` tool and lets `nats_request`
 * resolve a knight's domain from its name. Both runtimes wrap these functions in
 * their own tool definitions; the lookup itself lives here.
 *
 * Cards are cached in memory by a KV watch on `<table>.*` started at boot; until
 * the watch has loaded, every lookup reads the bucket directly.
 */
import type { NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import { cardsBucketFromEnv } from "./config.js";
import { log } from "./logger.js";
import { SERVICE_NAME } from "./service.js";

export interface CardSkill {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
}

/** The card fields the roster reads (A2A-like top level, Round Table fields under `roundtable`). */
export interface KnightCard {
  name: string;
  description?: string;
  skills?: CardSkill[];
  roundtable?: {
    table?: string;
    knight?: string;
    domain?: string;
    model?: string;
    tools?: string[];
    taskSubject?: string;
    phase?: string;
    readyReplicas?: number;
    suspended?: boolean;
  };
}

export type KnightStatus = "ready" | "suspended" | "not ready";

export interface FindKnightsQuery {
  /** Case-insensitive text matched against name, description and skill descriptions. */
  query?: string;
  /** Exact task domain. */
  domain?: string;
  /** A skill id or tag. */
  skill?: string;
  /** List suspended (scaled to zero) knights too. Default true: a task to them waits until they wake. */
  includeSuspended?: boolean;
}

export interface KnightMatch {
  name: string;
  domain: string;
  description: string;
  /** The skills that matched the filters; every skill when no skill/query filter matched on skills. */
  skills: Array<{ id: string; description: string }>;
  status: KnightStatus;
  /** A pod answered `$SRV.PING.roundtable-knight`; undefined when nobody answered the ping. */
  live?: boolean;
}

export const NO_ROSTER = "No roster available: this knight has no agent cards (ROUNDTABLE_TABLE or KNIGHT_CARDS_BUCKET is not set).";

export const FIND_KNIGHTS_DESCRIPTION = [
  "List the other knights at your table from their agent cards: name, domain, description, skills and status",
  "(ready, suspended, not ready; 'live' when a pod answered just now).",
  "Filter by free-text query, exact domain or skill id/tag. Call it before delegating with nats_request.",
].join(" ");

/** One prompt line for both runtimes. */
export const FIND_KNIGHTS_PROMPT_LINE =
  "Before delegating with nats_request, call find_knights to see who at your table can do it; nats_request then needs only the knight's name.";

export const FIND_KNIGHTS_PARAMS = {
  query: "Free text matched (case-insensitive) against knight names, descriptions and skill descriptions",
  domain: "Only knights with this exact task domain (e.g. 'security')",
  skill: "Only knights with a skill of this id or tag",
  includeSuspended: "Include suspended (scaled to zero) knights; tasks to them wait until they wake. Default true",
} as const;

const lc = (s: string | undefined) => (s ?? "").toLowerCase();

/** The knight name of a card: `roundtable.knight`, else `name`. */
export function cardKnight(card: KnightCard): string {
  return card.roundtable?.knight || card.name;
}

export function cardStatus(card: KnightCard): KnightStatus {
  const rt = card.roundtable ?? {};
  if (rt.suspended) return "suspended";
  if ((rt.readyReplicas ?? 0) > 0 || rt.phase === "Ready") return "ready";
  return "not ready";
}

/** Filter cards (pure). `self` is excluded; the result is sorted by name. */
export function filterKnights(cards: KnightCard[], q: FindKnightsQuery, self: string): KnightMatch[] {
  const query = lc(q.query?.trim());
  const domain = q.domain?.trim();
  const skill = lc(q.skill?.trim());
  const includeSuspended = q.includeSuspended ?? true;
  const out: KnightMatch[] = [];

  for (const card of cards) {
    const name = cardKnight(card);
    if (!name || lc(name) === lc(self)) continue;
    const status = cardStatus(card);
    if (!includeSuspended && status === "suspended") continue;
    const cardDomain = card.roundtable?.domain ?? "";
    if (domain && cardDomain !== domain) continue;

    let skills = card.skills ?? [];
    if (skill) {
      skills = skills.filter((s) => lc(s.id) === skill || (s.tags ?? []).some((t) => lc(t) === skill));
      if (skills.length === 0) continue;
    }
    if (query) {
      const textHit = lc(name).includes(query) || lc(card.description).includes(query);
      const skillHits = skills.filter((s) => lc(s.description).includes(query) || lc(s.id).includes(query));
      if (!textHit && skillHits.length === 0) continue;
      if (!textHit) skills = skillHits;
    }
    out.push({
      name,
      domain: cardDomain,
      description: card.description ?? "",
      skills: skills.map((s) => ({ id: s.id, description: s.description ?? "" })),
      status,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const MAX_SKILLS_SHOWN = 8;
const MAX_SKILL_DESC = 120;

/** Compact text for the model. */
export function formatKnightMatches(matches: KnightMatch[]): string {
  if (matches.length === 0) return "No knight at your table matches.";
  const lines = [`${matches.length} knight(s) at your table:`];
  for (const m of matches) {
    const status = m.live ? `${m.status}, live` : m.status;
    lines.push(`- ${m.name} (domain: ${m.domain || "none"}, ${status})${m.description ? `: ${m.description}` : ""}`);
    for (const s of m.skills.slice(0, MAX_SKILLS_SHOWN)) {
      const d = s.description.length > MAX_SKILL_DESC ? `${s.description.slice(0, MAX_SKILL_DESC)}…` : s.description;
      lines.push(`    - ${s.id}${d ? `: ${d}` : ""}`);
    }
    if (m.skills.length > MAX_SKILLS_SHOWN) lines.push(`    - …and ${m.skills.length - MAX_SKILLS_SHOWN} more`);
  }
  return lines.join("\n");
}

/** Where the roster comes from. The NATS implementation is `natsCardSource`; tests pass fakes. */
export interface CardSource {
  /** Read every card of the table directly. */
  readAll(): Promise<KnightCard[]>;
  /**
   * Watch the table's cards: `apply(knight, card | null, revision)` for every current value and
   * every change (null = deleted), `ready()` once the current values are in, `ended(err?)` when the
   * watch stops on its own (iterator finished or threw). Returns a stop function.
   */
  watch?(
    apply: (knight: string, card: KnightCard | null, revision: number) => void,
    ready: () => void,
    ended: (err?: unknown) => void,
  ): Promise<() => void>;
  /** Knight names (lower case) at this table with a pod answering the micro service PING. */
  ping?(): Promise<Set<string>>;
}

export interface RosterOptions {
  self: string;
  source: CardSource;
}

export type ResolvedTarget = { knight: string; domain: string } | { error: string };

/** Back-off between attempts to restart an ended watch: 5 s doubling to 60 s. */
export const ROSTER_RETRY_MIN_MS = 5_000;
export const ROSTER_RETRY_MAX_MS = 60_000;

export class Roster {
  private readonly cache = new Map<string, { card: KnightCard | null; revision: number }>();
  private watching = false;
  /** A watch failure was logged since the last successful load; later retries stay quiet. */
  private failureLogged = false;
  private stopWatch: (() => void) | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryMs = ROSTER_RETRY_MIN_MS;
  private stopped = false;
  /** Bumped per watch attempt so a late callback from an old watch is ignored. */
  private generation = 0;

  constructor(private readonly opts: RosterOptions) {}

  /** Start the KV watch. Lookups read directly until it has loaded; if it ends or fails they go back to direct reads and the watch is retried with back-off. */
  async start(): Promise<void> {
    if (!this.opts.source.watch) return;
    this.stopped = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const gen = ++this.generation;
    try {
      const stop = await this.opts.source.watch(
        (knight, card, revision) => {
          if (gen !== this.generation) return;
          const key = lc(knight);
          const prev = this.cache.get(key);
          if (prev && prev.revision > revision) return;
          this.cache.set(key, { card, revision });
        },
        () => {
          if (gen !== this.generation) return;
          this.watching = true;
          this.failureLogged = false;
          this.retryMs = ROSTER_RETRY_MIN_MS;
          log.info("Roster watch loaded", { knights: this.cachedCards().length });
        },
        (err) => {
          if (gen !== this.generation) return;
          this.onEnded(err);
        },
      );
      if (gen !== this.generation) stop();
      else this.stopWatch = stop;
    } catch (e) {
      if (gen !== this.generation) return;
      this.onEnded(e);
    }
  }

  private onEnded(err?: unknown): void {
    if (this.stopped) return;
    const wasWatching = this.watching;
    this.watching = false;
    this.cache.clear();
    this.generation++; // drop callbacks from the dead watch
    this.stopWatch = null;
    // Log the first failure of each outage (including a watch that never loaded); retries stay quiet.
    if (wasWatching || !this.failureLogged) {
      log.warn("Roster watch ended — reading cards directly", { error: err === undefined ? undefined : String(err) });
    }
    this.failureLogged = true;
    if (this.retryTimer) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, ROSTER_RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.start();
    }, delay);
    this.retryTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryMs = ROSTER_RETRY_MIN_MS;
    this.stopWatch?.();
    this.stopWatch = null;
    this.watching = false;
    this.cache.clear();
  }

  /** Whether lookups are served from the watch cache. */
  get cached(): boolean {
    return this.watching;
  }

  private cachedCards(): KnightCard[] {
    return [...this.cache.values()].flatMap((e) => (e.card ? [e.card] : []));
  }

  async cards(): Promise<KnightCard[]> {
    if (this.watching) return this.cachedCards();
    return this.opts.source.readAll();
  }

  async find(q: FindKnightsQuery): Promise<KnightMatch[]> {
    const matches = filterKnights(await this.cards(), q, this.opts.self);
    if (matches.length === 0 || !this.opts.source.ping) return matches;
    let live: Set<string>;
    try {
      live = await this.opts.source.ping();
    } catch {
      return matches;
    }
    if (live.size === 0) return matches; // nobody answered: no liveness info
    return matches.map((m) => ({ ...m, live: live.has(lc(m.name)) }));
  }

  /** Resolve a knight name (case-insensitive) to its card's name and domain. */
  async resolve(name: string): Promise<ResolvedTarget> {
    const cards = (await this.cards()).filter((c) => lc(cardKnight(c)) !== lc(this.opts.self));
    const card = cards.find((c) => lc(cardKnight(c)) === lc(name.trim()));
    if (!card) {
      const names = cards.map(cardKnight).sort();
      return {
        error: `Unknown knight "${name}": no agent card at your table. Valid names: ${names.length ? names.join(", ") : "(none)"}.`,
      };
    }
    const domain = card.roundtable?.domain;
    if (!domain) return { error: `Knight "${cardKnight(card)}" has no domain on its card; pass domain explicitly.` };
    return { knight: cardKnight(card), domain };
  }
}

/** The KV bucket and table from the pod env; null when the operator did not set them (older operator). */
export function rosterConfigFromEnv(env: NodeJS.ProcessEnv): { bucket: string; table: string } | null {
  const bucket = cardsBucketFromEnv(env);
  const table = env["ROUNDTABLE_TABLE"]?.trim();
  if (!bucket || !table || table === "none") return null;
  return { bucket, table };
}

const PING_TIMEOUT_MS = 300;

function parseCard(raw: () => KnightCard): KnightCard | null {
  try {
    const c = raw();
    return c && typeof c === "object" && typeof c.name === "string" ? c : null;
  } catch {
    return null;
  }
}

/**
 * Cards from NATS KV and liveness from the micro service PING. `getConnection` is called
 * lazily so the source can be built before NATS connects (the stdio MCP server connects in the background).
 */
export function natsCardSource(getConnection: () => NatsConnection | null, bucket: string, table: string): CardSource {
  let kvP: Promise<KV> | null = null;
  const kv = (): Promise<KV> => {
    const nc = getConnection();
    if (!nc) return Promise.reject(new Error("NATS not connected"));
    kvP ??= new Kvm(nc).open(bucket).catch((e) => {
      kvP = null;
      throw e;
    });
    return kvP;
  };
  const prefix = `${table}.`;
  const filter = `${table}.*`;

  return {
    async readAll() {
      const store = await kv();
      const keys: string[] = [];
      for await (const k of await store.keys(filter)) keys.push(k);
      const cards: KnightCard[] = [];
      for (const k of keys) {
        const e = await store.get(k);
        if (!e || e.operation !== "PUT") continue;
        const card = parseCard(() => e.json<KnightCard>());
        if (card) cards.push(card);
      }
      return cards;
    },

    async watch(apply, ready, ended) {
      const store = await kv();
      const iter = await store.watch({ key: filter });
      let loaded = false;
      const markLoaded = () => {
        if (!loaded) {
          loaded = true;
          ready();
        }
      };
      (async () => {
        for await (const e of iter) {
          const knight = e.key.startsWith(prefix) ? e.key.slice(prefix.length) : e.key;
          apply(knight, e.operation === "PUT" ? parseCard(() => e.json<KnightCard>()) : null, e.revision);
          if (e.isUpdate || e.delta === 0) markLoaded();
        }
        ended();
      })().catch((err) => ended(err));
      // Seed with a direct read too, so an empty table (no watch entries) still counts as loaded;
      // revisions keep the newer of the two when both report a key.
      void (async () => {
        const keys: string[] = [];
        for await (const k of await store.keys(filter)) keys.push(k);
        for (const k of keys) {
          const e = await store.get(k);
          if (!e) continue;
          apply(k.slice(prefix.length), e.operation === "PUT" ? parseCard(() => e.json<KnightCard>()) : null, e.revision);
        }
        markLoaded();
      })().catch((err) => log.warn("Roster seed read failed", { error: String(err) }));
      return () => iter.stop();
    },

    async ping() {
      const nc = getConnection();
      const live = new Set<string>();
      if (!nc) return live;
      try {
        const replies = await nc.requestMany(`$SRV.PING.${SERVICE_NAME}`, undefined, { maxWait: PING_TIMEOUT_MS, strategy: "timer" });
        for await (const m of replies) {
          try {
            const md = m.json<{ metadata?: Record<string, string> }>().metadata ?? {};
            if (md["table"] === table && md["knight"]) live.add(lc(md["knight"]));
          } catch {
            // not a service identity
          }
        }
      } catch {
        // no responders / timeout: no liveness info
      }
      return live;
    },
  };
}

let roster: Roster | null = null;

/**
 * Build and start the process-wide roster from the pod env. Returns null (and tools fall back to
 * today's behaviour) when KNIGHT_CARDS_BUCKET or ROUNDTABLE_TABLE is missing.
 */
export function initRoster(
  env: NodeJS.ProcessEnv,
  self: string,
  getConnection: () => NatsConnection | null,
  source?: CardSource,
): Roster | null {
  roster?.stop();
  roster = null;
  const cfg = rosterConfigFromEnv(env);
  if (!cfg && !source) {
    log.info("No agent card roster (KNIGHT_CARDS_BUCKET or ROUNDTABLE_TABLE unset)");
    return null;
  }
  roster = new Roster({ self, source: source ?? natsCardSource(getConnection, cfg!.bucket, cfg!.table) });
  return roster;
}

export function getRoster(): Roster | null {
  return roster;
}

/** Clear the process-wide roster (tests). */
export function resetRoster(): void {
  roster?.stop();
  roster = null;
}

/** The find_knights tool body shared by both runtimes. */
export async function findKnightsText(q: FindKnightsQuery): Promise<{ text: string; isError?: boolean }> {
  const r = getRoster();
  if (!r) return { text: NO_ROSTER };
  try {
    return { text: formatKnightMatches(await r.find(q)) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn("find_knights failed", { error: msg });
    return { text: `Error reading the roster: ${msg}`, isError: true };
  }
}

/**
 * The target of a nats_request. With a domain: unchanged (no lookup). Without one: the domain
 * from the target's card; an unknown name is rejected with the valid names. Without a roster
 * the domain stays required.
 */
export async function resolveRequestTarget(knight: string, domain?: string): Promise<ResolvedTarget> {
  if (domain && domain.trim()) return { knight, domain: domain.trim() };
  const r = getRoster();
  if (!r) return { error: `domain is required: ${NO_ROSTER}` };
  try {
    return await r.resolve(knight);
  } catch (e) {
    return { error: `Could not look up ${knight}'s domain (${e instanceof Error ? e.message : String(e)}); pass domain explicitly.` };
  }
}
