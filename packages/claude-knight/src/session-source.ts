/**
 * claude-knight's session source for the core introspection responder. Claude
 * Code keeps no long-lived session in memory, so there is no live session:
 * `recent`/`tree` show the latest transcript and `stats` summarizes the recent
 * tasks. Transcripts come from the Agent SDK's listSessions/getSessionMessages
 * in the sdk runtime, and are read from $CLAUDE_CONFIG_DIR/projects JSONL
 * (sessions.ts) in the cli runtime.
 */
import { getSessionMessages, listSessions, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { listInflight, type IntrospectOptions, type SessionSource } from "@roundtable/knight-core";
import type { KnightConfig } from "./config.js";

import { getRecentTasks } from "./knight.js";
import { snapshot as planSnapshot } from "./plan-limits.js";
import { listTranscripts, readTranscript } from "./sessions.js";

interface SessionSummary {
  sessionId: string;
  lastModified: number;
  fileSize?: number;
  firstPrompt?: string;
  summary?: string;
}

type Config = Pick<
  KnightConfig,
  "knightName" | "runtime" | "claudeConfigDir" | "workDir" | "claudeModel" | "authMode" | "podName" | "nodeName"
>;

/** Sessions newest first, from whichever store the runtime writes. */
async function sessionList(config: Config, limit: number): Promise<SessionSummary[]> {
  if (config.runtime === "cli") {
    try {
      return listTranscripts(config.claudeConfigDir, config.workDir, limit);
    } catch {
      return [];
    }
  }
  return listSessions({ dir: config.workDir, limit }).catch(() => []);
}

async function sessionMessages(config: Config, id: string): Promise<SessionMessage[] | null> {
  if (config.runtime === "cli") {
    try {
      return readTranscript(config.claudeConfigDir, config.workDir, id) as unknown as SessionMessage[] | null;
    } catch {
      return null;
    }
  }
  return getSessionMessages(id, { dir: config.workDir }).catch(() => null);
}

export function claudeSessionSource(config: Config): SessionSource<SessionMessage> {
  return {
    async listSessions(limit) {
      const sessions = await sessionList(config, limit);
      return {
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
    },
    async latestSessionId() {
      return (await sessionList(config, 1))[0]?.sessionId ?? null;
    },
    async readSession(id) {
      const entries = await sessionMessages(config, id);
      return entries ? { startedAt: null, entries } : null;
    },
    itemsForEntry: itemsForMessage,
    statsExtras() {
      const tasks = getRecentTasks();
      const totals = tasks.reduce(
        (acc, t) => ({ cost: acc.cost + t.costUsd, turns: acc.turns + t.turns, failed: acc.failed + (t.success ? 0 : 1) }),
        { cost: 0, turns: 0, failed: 0 },
      );
      return {
        session: {
          sessionId: tasks.at(-1)?.sessionId ?? null,
          recentTasks: tasks.length,
          failedTasks: totals.failed,
          turns: totals.turns,
          cost: totals.cost,
        },
        tasks: tasks.slice(-10),
      };
    },
    inflight: () => listInflight(),
    runtimeInfo: () => ({
      pod: config.podName,
      node: config.nodeName,
      model: config.claudeModel ?? "claude-code-default",
      runtime: "claude-knight",
      claudeRuntime: config.runtime,
      billing: config.authMode,
      plan: planSnapshot(),
    }),
  };
}

/** Options for the core's startIntrospect / handleIntrospect. */
export function introspectOptions(config: Config): IntrospectOptions<SessionMessage> {
  return {
    knight: config.knightName,
    source: claudeSessionSource(config),
    identity: { pod: config.podName, ...(config.nodeName ? { node: config.nodeName } : {}) },
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
    timestamp: (m as { timestamp?: string }).timestamp ?? null,
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
