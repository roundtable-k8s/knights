/**
 * Introspection: the read-only view of a knight's sessions behind the
 * dashboard's Session Explorer. Served over NATS on
 * `<prefix>.introspect.<Knight>` (queue group `introspect`, so one replica
 * answers) and `<prefix>.introspect.<Knight>.<pod>` (one specific replica), and
 * over HTTP on `/introspect?type=…`.
 *
 * Request types: `stats`, `recent`, `tree` (the live session, or the latest
 * persisted one when nothing is live), `history` (persisted sessions) and
 * `session` (one persisted session, paged). The routing, paging, limits and the
 * reply envelope live here; each runtime supplies only a {@link SessionSource}.
 */
import type { Msg, NatsConnection, Subscription } from "@nats-io/transport-node";
import { log } from "./logger.js";
import { getConnection } from "./nats/index.js";
import { subjectToken } from "./activity.js";

export type IntrospectType = "stats" | "recent" | "tree" | "history" | "session";
export const INTROSPECT_TYPES: readonly IntrospectType[] = ["stats", "recent", "tree", "history", "session"];

export interface IntrospectRequest {
  type: IntrospectType;
  limit?: number;
  offset?: number;
  /** `session`: the persisted session id. */
  id?: string;
  /** `stats`/`recent`/`tree`: target the live session of this run instead of the most recent one. */
  runId?: string;
  /** `stats`/`recent`/`tree`: target the live session with this session id. */
  sessionId?: string;
}

/** One row of the dashboard's entry list or tree. */
export type IntrospectItem = Record<string, unknown>;

export interface SessionSelector {
  runId?: string;
  sessionId?: string;
}

/** A persisted session: its raw entries (paged by the core) and when it started. */
export interface PersistedSession<E> {
  startedAt: string | null;
  entries: E[];
}

/** A session held in memory by the runtime while tasks run. */
export interface LiveSession<E> {
  /** The `session` object of a `stats` reply. */
  stats(): Record<string, unknown>;
  /** All entries so far, oldest first (`recent` returns the last `limit`). */
  entries(): E[];
  /** The flattened tree nodes (`tree`). */
  tree(): IntrospectItem[];
}

/** What a runtime implements so the core can answer introspection. */
export interface SessionSource<E = unknown> {
  /** Persisted sessions, newest first, at most `limit` (history rows), plus how many exist. */
  listSessions(limit: number): Promise<{ sessions: Record<string, unknown>[]; total: number }>;
  /** Id of the newest persisted session (the fallback for `recent`/`tree`), or null. */
  latestSessionId(): Promise<string | null>;
  /** One persisted session, or null when there is none with this id. Ids are pre-validated. */
  readSession(id: string): Promise<PersistedSession<E> | null>;
  /** Map one raw entry to the dashboard's item shape (an entry can yield several items). */
  itemsForEntry(entry: E): IntrospectItem[];
  /**
   * The live session: the one matching `sel`, or the most recently used one when
   * `sel` is undefined. Omit when the runtime keeps no session in memory; then
   * selectors are ignored and `recent`/`tree` read the latest persisted session.
   */
  liveSession?(sel?: SessionSelector): LiveSession<E> | null;
  /** Extra `stats` fields when no live session answers (e.g. a summary of recent tasks). */
  statsExtras?(): Record<string, unknown>;
  /** Tasks currently executing on this pod. */
  inflight(): unknown[];
  /** Runtime fields merged into `runtime` (model, plan limits, …); they win over the defaults. */
  runtimeInfo(): Record<string, unknown>;
}

export interface IntrospectOptions<E = unknown> {
  knight: string;
  source: SessionSource<E>;
  /** Stamped on every reply so a dashboard can tell replicas apart. */
  identity: { pod: string; node?: string };
}

/** Cap the history list and the page size (keeps a NATS reply under the ~1 MB payload limit). */
export const MAX_HISTORY = 60;
export const MAX_SESSION_ENTRIES = 500;
export const DEFAULT_SESSION_ENTRIES = 200;
export const DEFAULT_RECENT_ENTRIES = 20;
/** Session ids are uuids; anything else is rejected so a request can never escape a sessions dir. */
export const SESSION_ID_RE = /^[0-9a-fA-F-]+$/;

const startTime = Date.now();

/** Answer one request. The reply always carries `pod` (and `node` when known). */
export async function handleIntrospect<E>(req: IntrospectRequest, opts: IntrospectOptions<E>): Promise<Record<string, unknown>> {
  const { pod, node } = opts.identity;
  const reply = await route(req ?? { type: "stats" }, opts);
  return { pod, ...(node ? { node } : {}), ...reply };
}

async function route<E>(req: IntrospectRequest, opts: IntrospectOptions<E>): Promise<Record<string, unknown>> {
  const { knight, source } = opts;
  switch (req.type) {
    case "history":
      return { knight, ...(await source.listSessions(MAX_HISTORY)) };
    case "session":
      return buildSession(opts, req.id, req.limit, req.offset);
    case "stats":
    case "recent":
    case "tree":
      break;
    default:
      return { error: `Unknown introspect type: ${String((req as { type?: unknown }).type)}` };
  }

  const sel = req.runId || req.sessionId ? { runId: req.runId, sessionId: req.sessionId } : undefined;
  const live = source.liveSession ? source.liveSession(sel) : null;
  if (sel && source.liveSession && !live) {
    return { error: `No live session on this pod for ${req.runId ? `runId ${req.runId}` : `sessionId ${req.sessionId}`}` };
  }

  if (req.type === "stats") {
    return {
      knight,
      session: live ? live.stats() : null,
      ...(live ? {} : source.statsExtras?.()),
      inflight: source.inflight(),
      runtime: runtimeInfo(source),
    };
  }

  const limit = positive(req.limit) ?? DEFAULT_RECENT_ENTRIES;
  if (live) {
    if (req.type === "tree") {
      const nodes = live.tree();
      return { knight, nodes, totalNodes: nodes.length };
    }
    const all = live.entries();
    const recent = all.slice(-limit);
    return { knight, entries: recent.flatMap((e) => source.itemsForEntry(e)), total: all.length, returned: recent.length };
  }

  // Nothing live: show the newest persisted session instead.
  const latest = await source.latestSessionId();
  const persisted = latest && SESSION_ID_RE.test(latest) ? await source.readSession(latest) : null;
  if (!latest || !persisted) {
    return req.type === "tree"
      ? { knight, nodes: [], totalNodes: 0 }
      : { knight, entries: [], total: 0, returned: 0 };
  }
  if (req.type === "tree") {
    const nodes = persisted.entries.slice(-MAX_SESSION_ENTRIES).flatMap((e) => source.itemsForEntry(e));
    return { knight, id: latest, nodes, totalNodes: nodes.length };
  }
  const recent = persisted.entries.slice(-Math.min(limit, MAX_SESSION_ENTRIES));
  return {
    knight,
    id: latest,
    entries: recent.flatMap((e) => source.itemsForEntry(e)),
    total: persisted.entries.length,
    returned: recent.length,
  };
}

function runtimeInfo<E>(source: SessionSource<E>): Record<string, unknown> {
  return {
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeTasks: source.inflight().length,
    ...source.runtimeInfo(),
  };
}

function positive(n: number | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

async function buildSession<E>(
  opts: IntrospectOptions<E>,
  id: string | undefined,
  limit?: number,
  offset?: number,
): Promise<Record<string, unknown>> {
  if (!id || !SESSION_ID_RE.test(id)) return { error: "Invalid or missing session id" };
  const persisted = await opts.source.readSession(id);
  if (!persisted) return { error: `Session not found: ${id}` };
  const { entries } = persisted;
  const start = typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const count = Math.min(positive(limit) ?? DEFAULT_SESSION_ENTRIES, MAX_SESSION_ENTRIES);
  const page = entries.slice(start, start + count);
  return {
    knight: opts.knight,
    id,
    startedAt: persisted.startedAt,
    entries: page.flatMap((e) => opts.source.itemsForEntry(e)),
    total: entries.length,
    offset: start,
    returned: page.length,
    hasMore: start + page.length < entries.length,
  };
}

/** Parse an HTTP `/introspect` query (`type`, `limit`, `offset`, `id`, `runId`, `sessionId`). */
export function introspectRequestFromQuery(params: URLSearchParams): IntrospectRequest {
  const num = (k: string) => {
    const v = params.get(k);
    if (v == null) return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (k: string) => params.get(k) || undefined;
  const req: IntrospectRequest = { type: (params.get("type") ?? "stats") as IntrospectType };
  const limit = num("limit");
  const offset = num("offset");
  if (limit !== undefined) req.limit = limit;
  if (offset !== undefined) req.offset = offset;
  for (const k of ["id", "runId", "sessionId"] as const) {
    const v = str(k);
    if (v !== undefined) req[k] = v;
  }
  return req;
}

/** The per-pod subject token: the pod name with anything NATS-unsafe replaced by `_`. */
export function podSubjectToken(pod: string): string {
  return subjectToken(pod);
}

export interface StartIntrospectOptions<E = unknown> extends IntrospectOptions<E> {
  /** Subject prefix, `<prefix>` of `<prefix>.results`. */
  prefix: string;
  /** Defaults to the core's shared connection. */
  nc?: NatsConnection | null;
}

const decoder = new TextDecoder();

/**
 * Subscribe the responder: `<prefix>.introspect.<Knight>` in queue group
 * `introspect` (exactly one replica answers) and `<prefix>.introspect.<Knight>.<pod>`.
 * Returns the subscriptions, or null when NATS is not connected.
 */
export function startIntrospect<E>(opts: StartIntrospectOptions<E>): Subscription[] | null {
  const nc = opts.nc === undefined ? getConnection() : opts.nc;
  if (!nc) {
    log.warn("Cannot start introspect — NATS not connected");
    return null;
  }
  const base = `${opts.prefix}.introspect.${subjectToken(opts.knight)}`;
  const podSubject = `${base}.${podSubjectToken(opts.identity.pod)}`;
  const subs = [nc.subscribe(base, { queue: "introspect" }), nc.subscribe(podSubject)];
  log.info("Introspect responder started", { subjects: [base, podSubject], pod: opts.identity.pod });
  const maxPayload = () => nc.info?.max_payload;
  for (const sub of subs) void serve(sub, opts, maxPayload);
  return subs;
}

async function serve<E>(sub: Subscription, opts: IntrospectOptions<E>, maxPayload: () => number | undefined): Promise<void> {
  for await (const msg of sub) {
    // One bad message must not end the loop: a rejection here would leave the responder dead.
    try {
      await answer(msg, opts, maxPayload);
    } catch (err) {
      log.error("Introspect responder failed to answer", { error: errorMessage(err) });
    }
  }
}

async function answer<E>(msg: Msg, opts: IntrospectOptions<E>, maxPayload: () => number | undefined): Promise<void> {
  let req: IntrospectRequest = { type: "stats" };
  try {
    const parsed = JSON.parse(decoder.decode(msg.data));
    if (parsed && typeof parsed === "object") req = parsed;
  } catch {
    // not JSON: default to stats
  }
  let body: Record<string, unknown>;
  try {
    body = await handleIntrospect(req, opts);
  } catch (err) {
    const error = errorMessage(err);
    log.error("Introspect error", { error });
    body = errorBody(opts, error);
  }
  const payload = JSON.stringify(body);
  try {
    msg.respond(payload);
  } catch (err) {
    // Typically the reply exceeded the server's max_payload: say so instead of going silent.
    const cause = errorMessage(err);
    const bytes = new TextEncoder().encode(payload).length;
    log.error("Introspect reply failed", { error: cause, bytes });
    const error = /max_payload/i.test(cause)
      ? oversizedMessage(bytes, req, maxPayload())
      : `reply failed: ${cause}`;
    msg.respond(JSON.stringify(errorBody(opts, error)));
  }
}

/** Names the size, the server's limit and a concrete smaller entry count (estimated from the caller's limit). */
function oversizedMessage(bytes: number, req: IntrospectRequest, max: number | undefined): string {
  const limit = max ? ` (server max_payload ${max} bytes)` : "";
  const head = `reply too large (${bytes} bytes)${limit}`;
  // The estimate is linear and ignores envelope overhead, so keep a 10 % margin below it.
  const fit = max && req.limit !== undefined && req.limit >= 1 ? Math.floor((req.limit * max * 0.9) / bytes) : NaN;
  if (!(fit >= 1) || fit >= req.limit!) return `${head}: request fewer entries with a smaller limit`;
  return `${head}: request at most ${fit} entries (limit=${fit})`;
}

function errorBody<E>(opts: IntrospectOptions<E>, error: string): Record<string, unknown> {
  const { pod, node } = opts.identity;
  return { pod, ...(node ? { node } : {}), error };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
