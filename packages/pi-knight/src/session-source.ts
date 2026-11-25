/**
 * pi-knight's session source for the core introspection responder: live
 * sessions come from knight.ts, persisted ones from the pi session JSONL files
 * (sessions.ts), mapped to the dashboard's shapes by introspect-format.ts.
 */
import { readFile } from "node:fs/promises";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { IntrospectItem, IntrospectOptions, LiveSession, SessionSource } from "@roundtable/knight-core";
import { findSession, getActiveSession } from "./knight.js";
import { listInflight, podIdentity } from "@roundtable/knight-core";
import { listSessionFiles, SESSIONS_ROOT } from "./sessions.js";
import { parseSessionFile, recentItemsForEntry, summarizeEntry, summarizeSession } from "./introspect-format.js";
import type { KnightConfig } from "./config.js";

type Entry = any;
type TreeNode = { entry: Entry; children: TreeNode[]; label?: string };

/** Flatten pi's session tree to the dashboard's node list. */
export function flattenTree(nodes: TreeNode[]): IntrospectItem[] {
  const out: IntrospectItem[] = [];
  for (const node of nodes) {
    const e = node.entry;
    out.push({
      id: e.id,
      parentId: e.parentId,
      type: e.type,
      timestamp: e.timestamp,
      childrenCount: node.children.length,
      ...(node.label ? { label: node.label } : {}),
      summary: summarizeEntry(e),
    });
    if (node.children.length > 0) out.push(...flattenTree(node.children));
  }
  return out;
}

function live(session: AgentSession): LiveSession<Entry> {
  return {
    stats() {
      const s = session.getSessionStats();
      return {
        sessionId: s.sessionId,
        userMessages: s.userMessages,
        assistantMessages: s.assistantMessages,
        toolCalls: s.toolCalls,
        totalMessages: s.totalMessages,
        tokens: { input: s.tokens.input, output: s.tokens.output, total: s.tokens.total },
        cost: s.cost,
      };
    },
    entries: () => session.sessionManager.getEntries(),
    tree: () => flattenTree(session.sessionManager.getTree() as TreeNode[]),
  };
}

export function piSessionSource(config: Pick<KnightConfig, "knightModel">, root: string = SESSIONS_ROOT): SessionSource<Entry> {
  return {
    async listSessions(limit) {
      const files = await listSessionFiles(root);
      const sessions: Record<string, unknown>[] = [];
      for (const f of files.slice(0, limit)) {
        try {
          sessions.push(summarizeSession(parseSessionFile(await readFile(f.path, "utf8")), { id: f.id, sizeBytes: f.sizeBytes }));
        } catch {
          // unreadable file — skip rather than fail the whole listing
        }
      }
      return { sessions, total: files.length };
    },
    async latestSessionId() {
      return (await listSessionFiles(root))[0]?.id ?? null;
    },
    async readSession(id) {
      const file = (await listSessionFiles(root)).find((f) => f.id === id);
      if (!file) return null;
      const { header, entries } = parseSessionFile(await readFile(file.path, "utf8"));
      return { startedAt: header?.timestamp ?? entries[0]?.timestamp ?? null, entries };
    },
    itemsForEntry: (entry) => recentItemsForEntry(entry),
    liveSession(sel) {
      const s = sel ? findSession(sel) : getActiveSession();
      return s ? live(s) : null;
    },
    inflight: () => listInflight(),
    runtimeInfo: () => ({ model: config.knightModel }),
  };
}

/** Options for the core's startIntrospect / handleIntrospect. */
export function introspectOptions(config: KnightConfig): IntrospectOptions<Entry> {
  const { pod, node } = podIdentity();
  return { knight: config.knightName, source: piSessionSource(config), identity: { pod, ...(node ? { node } : {}) } };
}
