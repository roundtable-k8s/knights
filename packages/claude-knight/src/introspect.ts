/**
 * Introspection over NATS (<prefix>.introspect.<Knight>) and HTTP (/introspect),
 * answering the same request types as pi-knight so the dashboard's Session
 * Explorer works with both runtimes. Session data comes from Claude Code's own
 * transcripts via the Agent SDK's listSessions/getSessionMessages.
 */
import { getSessionMessages, listSessions, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Subscription } from "nats";
import type { KnightConfig } from "./config.js";
import { getRecentTasks } from "./knight.js";
import { log } from "./logger.js";
import { getConnection, StringCodec } from "./nats.js";
import { snapshot as planSnapshot } from "./plan-limits.js";

const sc = StringCodec();
const startTime = Date.now();
let sub: Subscription | null = null;
let activeTasks = 0;
export function setIntrospectActiveTasks(n: number): void {
  activeTasks = n;
}

export interface IntrospectRequest {
  type: "stats" | "recent" | "tree" | "history" | "session";
  limit?: number;
  offset?: number;
  id?: string;
}

const MAX_HISTORY = 60;
const MAX_SESSION_ENTRIES = 500;
const DEFAULT_SESSION_ENTRIES = 200;
const SESSION_ID_RE = /^[0-9a-fA-F-]+$/;

export function startIntrospect(config: KnightConfig): void {
  const nc = getConnection();
  if (!nc) {
    log.warn("Cannot start introspect — NATS not connected");
    return;
  }
  const prefix = config.natsResultsPrefix.replace(/\.results$/, "");
  const subject = `${prefix}.introspect.${config.knightName}`;
  sub = nc.subscribe(subject);
  log.info("Introspect responder started", { subject });
  (async () => {
    for await (const msg of sub!) {
      let req: IntrospectRequest = { type: "stats" };
      try {
        req = JSON.parse(sc.decode(msg.data));
      } catch {
        // default to stats
      }
      try {
        msg.respond(sc.encode(JSON.stringify(await handleIntrospect(req, config))));
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.error("Introspect error", { error });
        msg.respond(sc.encode(JSON.stringify({ error })));
      }
    }
  })();
}

function runtime(config: KnightConfig) {
  return {
    uptime: Math.floor((Date.now() - startTime) / 1000),
    activeTasks,
    model: config.claudeModel ?? "claude-code-default",
    runtime: "claude-knight",
    billing: config.authMode,
    plan: planSnapshot(),
  };
}

export async function handleIntrospect(req: IntrospectRequest, config: KnightConfig): Promise<unknown> {
  switch (req.type) {
    case "history":
      return buildHistory(config);
    case "session":
      return buildSession(config, req.id, req.limit, req.offset);
    case "recent":
    case "tree": {
      // No single long-lived session to walk: show the latest session instead.
      const [latest] = await listSessions({ dir: config.workDir, limit: 1 }).catch(() => []);
      if (!latest) return { knight: config.knightName, entries: [], total: 0, returned: 0 };
      const page = (await buildSession(config, latest.sessionId, req.limit ?? 20)) as Record<string, unknown>;
      return req.type === "tree" ? { knight: config.knightName, nodes: page.entries, totalNodes: page.total } : page;
    }
    case "stats":
    default: {
      const tasks = getRecentTasks();
      const totals = tasks.reduce(
        (acc, t) => ({ cost: acc.cost + t.costUsd, turns: acc.turns + t.turns, failed: acc.failed + (t.success ? 0 : 1) }),
        { cost: 0, turns: 0, failed: 0 },
      );
      return {
        knight: config.knightName,
        session: {
          sessionId: tasks.at(-1)?.sessionId ?? null,
          recentTasks: tasks.length,
          failedTasks: totals.failed,
          turns: totals.turns,
          cost: totals.cost,
        },
        tasks: tasks.slice(-10),
        runtime: runtime(config),
      };
    }
  }
}

async function buildHistory(config: KnightConfig) {
  const sessions = await listSessions({ dir: config.workDir, limit: MAX_HISTORY }).catch(() => []);
  return {
    knight: config.knightName,
    sessions: sessions.map((s) => ({
      id: s.sessionId,
      startedAt: null,
      lastModified: new Date(s.lastModified).toISOString(),
      firstPrompt: (s.firstPrompt ?? s.summary ?? "").slice(0, 140),
      summary: s.summary,
      sizeBytes: s.fileSize ?? null,
    })),
    total: sessions.length,
  };
}

async function buildSession(config: KnightConfig, id: string | undefined, limit?: number, offset?: number) {
  if (!id || !SESSION_ID_RE.test(id)) return { error: "Invalid or missing session id" };
  const start = Math.max(0, offset ?? 0);
  const count = Math.min(Math.max(1, limit ?? DEFAULT_SESSION_ENTRIES), MAX_SESSION_ENTRIES);
  const all = await getSessionMessages(id, { dir: config.workDir }).catch(() => null);
  if (!all) return { error: `Session not found: ${id}` };
  const page = all.slice(start, start + count);
  return {
    knight: config.knightName,
    id,
    startedAt: null,
    entries: page.flatMap(itemsForMessage),
    total: all.length,
    offset: start,
    returned: page.length,
    hasMore: start + page.length < all.length,
  };
}

type Block = { type?: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean; id?: string };

function previewContent(content: unknown, max = 500): string {
  if (typeof content === "string") return content.slice(0, max);
  if (Array.isArray(content)) {
    return (content as Block[])
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("\n")
      .slice(0, max);
  }
  return "";
}

/** Map a Claude Code transcript message to the dashboard's item shape (see pi-knight introspect-format.ts). */
export function itemsForMessage(m: SessionMessage): Record<string, unknown>[] {
  const msg = (m.message ?? {}) as { role?: string; content?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
  const base: Record<string, unknown> = {
    id: m.uuid,
    parentId: m.parent_tool_use_id,
    type: "message",
    timestamp: null,
    role: m.type,
  };
  const blocks: Block[] = Array.isArray(msg.content) ? (msg.content as Block[]) : [];

  if (m.type === "user") {
    const results = blocks.filter((b) => b?.type === "tool_result");
    if (results.length > 0) {
      return results.map((b, i) => {
        const out = previewContent(b.content);
        return { ...base, id: `${m.uuid}-tr-${i}`, type: "tool_result", toolName: null, output: out, text: b.is_error ? `⚠ ${out}` : out };
      });
    }
    return [{ ...base, text: previewContent(msg.content) }];
  }

  if (m.type === "assistant") {
    const text = previewContent(msg.content);
    if (text) base.text = text;
    if (msg.usage) base.tokens = { input: msg.usage.input_tokens ?? 0, output: msg.usage.output_tokens ?? 0 };
    const tools = blocks
      .filter((b) => b?.type === "tool_use")
      .map((b, i) => ({
        id: `${m.uuid}-tc-${b.id ?? i}`,
        parentId: m.uuid,
        type: "tool_use",
        timestamp: null,
        role: "assistant",
        toolName: b.name,
        input: JSON.stringify(b.input ?? {}).slice(0, 500),
      }));
    return [base, ...tools];
  }

  return [{ ...base, text: previewContent(msg.content) }];
}
