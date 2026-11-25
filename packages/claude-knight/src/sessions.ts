/**
 * Claude Code session transcripts read straight from disk, for introspect in
 * the cli runtime (the sdk runtime keeps using the Agent SDK's listSessions /
 * getSessionMessages). The CLI writes one JSONL file per session to
 * $CLAUDE_CONFIG_DIR/projects/<project>/<sessionId>.jsonl, where <project> is
 * the working directory with every non-alphanumeric character replaced by "-"
 * (/data → -data). Lines carry many record types; only the main-thread user
 * and assistant messages matter here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Same shape as the Agent SDK's SessionMessage, so introspect can map both alike. */
export interface TranscriptMessage {
  type: "user" | "assistant";
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
  timestamp?: string;
}

export interface TranscriptInfo {
  sessionId: string;
  lastModified: number;
  fileSize: number;
  firstPrompt?: string;
  summary?: string;
}

const SESSION_FILE_RE = /^([0-9a-fA-F-]{8,})\.jsonl$/;

export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function projectsRoot(configDir: string): string {
  return join(configDir, "projects");
}

/** Project directories to look in: the one for workDir first, then any other (long paths get hashed names). */
function candidateDirs(configDir: string, workDir: string): string[] {
  const root = projectsRoot(configDir);
  if (!existsSync(root)) return [];
  const own = join(root, projectDirName(workDir));
  const others = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(root, d.name))
    .filter((d) => d !== own);
  return existsSync(own) ? [own, ...others] : others;
}

function parseLines(raw: string): any[] {
  const out: any[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a partially written last line while the session is live
    }
  }
  return out;
}

function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b: any) => b?.type === "text" && typeof b.text === "string" && !b.text.startsWith("<system-reminder>"))
      .map((b: any) => b.text as string);
    return texts.at(-1) ?? "";
  }
  return "";
}

function isMainMessage(rec: any): boolean {
  return (rec?.type === "user" || rec?.type === "assistant") && !rec.isSidechain && !rec.isMeta && rec.message;
}

export function toTranscriptMessages(records: any[]): TranscriptMessage[] {
  return records.filter(isMainMessage).map((rec) => ({
    type: rec.type,
    uuid: rec.uuid,
    session_id: rec.sessionId,
    message: rec.message,
    parent_tool_use_id: null,
    timestamp: rec.timestamp,
  }));
}

function summarize(file: string, sessionId: string): TranscriptInfo {
  const st = statSync(file);
  const records = parseLines(readFileSync(file, "utf8"));
  // Tool results carry no text blocks, so promptText skips them.
  const firstUser = records.find((r) => isMainMessage(r) && r.type === "user" && promptText(r.message.content));
  const summaryRec = [...records].reverse().find((r) => r?.type === "summary" || r?.type === "custom-title" || r?.type === "ai-title");
  return {
    sessionId,
    lastModified: st.mtimeMs,
    fileSize: st.size,
    firstPrompt: firstUser ? promptText(firstUser.message.content) : undefined,
    summary: summaryRec?.summary ?? summaryRec?.customTitle ?? summaryRec?.title,
  };
}

/** Sessions newest first. */
export function listTranscripts(configDir: string, workDir: string, limit: number): TranscriptInfo[] {
  const files: Array<{ file: string; id: string; mtime: number }> = [];
  const seen = new Set<string>();
  for (const dir of candidateDirs(configDir, workDir)) {
    for (const name of readdirSync(dir)) {
      const m = name.match(SESSION_FILE_RE);
      if (!m || seen.has(m[1]!)) continue;
      seen.add(m[1]!);
      const file = join(dir, name);
      files.push({ file, id: m[1]!, mtime: statSync(file).mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, Math.max(0, limit)).map((f) => summarize(f.file, f.id));
}

/** Main-thread messages of one session, or null when there is no such transcript. */
export function readTranscript(configDir: string, workDir: string, sessionId: string): TranscriptMessage[] | null {
  if (!/^[0-9a-fA-F-]+$/.test(sessionId)) return null;
  for (const dir of candidateDirs(configDir, workDir)) {
    const file = join(dir, `${sessionId}.jsonl`);
    if (existsSync(file)) return toTranscriptMessages(parseLines(readFileSync(file, "utf8")));
  }
  return null;
}
