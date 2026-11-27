/**
 * Claude Code session transcripts read straight from disk, for introspect in
 * the cli runtime (the sdk runtime keeps using the Agent SDK's listSessions /
 * getSessionMessages). The CLI writes one JSONL file per session to
 * $CLAUDE_CONFIG_DIR/projects/<project>/<sessionId>.jsonl, where <project> is
 * the working directory with every non-alphanumeric character replaced by "-"
 * (/data → -data). Lines carry many record types; only the main-thread user
 * and assistant messages matter here.
 *
 * All file access is asynchronous so a Session Explorer request cannot stall
 * the event loop (and with it a running task's heartbeats). Listing only stats
 * files; summaries read just the head and tail of each transcript.
 */
import { open, readdir, readFile, stat, type FileHandle } from "node:fs/promises";
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
/** Bytes read from the start (first prompt) and the end (title/summary) of a transcript. */
const WINDOW_BYTES = 64 * 1024;
/** Files stat'ed at once while listing; bounds open descriptors on a busy PVC. */
const STAT_CONCURRENCY = 16;
const NEWLINE = 0x0a;

export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function projectsRoot(configDir: string): string {
  return join(configDir, "projects");
}

/** Project directories to look in: the one for workDir first, then any other (long paths get hashed names). */
async function candidateDirs(configDir: string, workDir: string): Promise<string[]> {
  const root = projectsRoot(configDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const own = projectDirName(workDir);
  const names = entries.filter((d) => d.isDirectory()).map((d) => d.name);
  const others = names.filter((n) => n !== own).map((n) => join(root, n));
  return names.includes(own) ? [join(root, own), ...others] : others;
}

/** Run fn over items with at most `limit` in flight; results keep the input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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

async function readRange(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/**
 * The first and last WINDOW_BYTES of a transcript, cut back to whole lines.
 * A file that fits in two windows is returned whole as both parts.
 */
async function readEdges(file: string, size: number): Promise<{ head: Buffer; tail: Buffer }> {
  const fh = await open(file, "r");
  try {
    if (size <= 2 * WINDOW_BYTES) {
      const all = await readRange(fh, 0, size);
      return { head: all, tail: all };
    }
    // One extra byte on each side tells an edge that lands exactly on a line boundary
    // (keep the record) from one that cuts a record (drop it).
    const headRaw = await readRange(fh, 0, WINDOW_BYTES + 1);
    const tailRaw = await readRange(fh, size - WINDOW_BYTES - 1, WINDOW_BYTES + 1);
    const headCut = headRaw.length > WINDOW_BYTES && headRaw[WINDOW_BYTES] === NEWLINE ? WINDOW_BYTES : headRaw.subarray(0, WINDOW_BYTES).lastIndexOf(NEWLINE);
    const firstNewline = tailRaw[0] === NEWLINE ? 0 : tailRaw.indexOf(NEWLINE);
    const tailStart = firstNewline < 0 ? -1 : firstNewline + 1;
    return {
      head: headCut < 0 ? Buffer.alloc(0) : headRaw.subarray(0, headCut),
      tail: tailStart < 0 ? Buffer.alloc(0) : tailRaw.subarray(tailStart),
    };
  } finally {
    await fh.close();
  }
}

/**
 * Summaries come from the head and tail only. The first prompt is found in the
 * head, so a first record longer than the window leaves firstPrompt unset; the
 * title/summary record is taken from the tail.
 */
async function summarize(file: string, sessionId: string, st: { size: number; mtimeMs: number }): Promise<TranscriptInfo> {
  const { head, tail } = await readEdges(file, st.size);
  // Tool results carry no text blocks, so promptText skips them.
  const firstUser = parseLines(head.toString("utf8")).find(
    (r) => isMainMessage(r) && r.type === "user" && promptText(r.message.content),
  );
  const isTitle = (r: any) => r?.type === "summary" || r?.type === "custom-title" || r?.type === "ai-title";
  const summaryRec =
    parseLines(tail.toString("utf8")).reverse().find(isTitle) ?? parseLines(head.toString("utf8")).reverse().find(isTitle);
  return {
    sessionId,
    lastModified: st.mtimeMs,
    fileSize: st.size,
    firstPrompt: firstUser ? promptText(firstUser.message.content) : undefined,
    summary: summaryRec?.summary ?? summaryRec?.customTitle ?? summaryRec?.title,
  };
}

interface SessionFile {
  file: string;
  id: string;
  size: number;
  mtimeMs: number;
}

/** Every session file across the project dirs, newest first. Files that vanish mid-listing are skipped. */
async function listSessionFiles(configDir: string, workDir: string): Promise<SessionFile[]> {
  const candidates: Array<{ file: string; id: string }> = [];
  const seen = new Set<string>();
  for (const dir of await candidateDirs(configDir, workDir)) {
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const m = name.match(SESSION_FILE_RE);
      if (!m || seen.has(m[1]!)) continue;
      seen.add(m[1]!);
      candidates.push({ file: join(dir, name), id: m[1]! });
    }
  }
  const stats = await mapLimit(candidates, STAT_CONCURRENCY, (c) => stat(c.file).then((st) => st, () => null));
  const files: SessionFile[] = [];
  candidates.forEach((c, i) => {
    const st = stats[i];
    if (st) files.push({ ...c, size: st.size, mtimeMs: st.mtimeMs });
  });
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Sessions newest first. Only the newest `limit` are summarized. */
export async function listTranscripts(configDir: string, workDir: string, limit: number): Promise<TranscriptInfo[]> {
  const newest = (await listSessionFiles(configDir, workDir)).slice(0, Math.max(0, limit));
  const summaries = await mapLimit(newest, STAT_CONCURRENCY, (f) =>
    summarize(f.file, f.id, f).then((s) => s, () => null),
  );
  return summaries.filter((s): s is TranscriptInfo => s !== null);
}

/** Main-thread messages of one session, or null when there is no such transcript. */
export async function readTranscript(configDir: string, workDir: string, sessionId: string): Promise<TranscriptMessage[] | null> {
  if (!/^[0-9a-fA-F-]+$/.test(sessionId)) return null;
  for (const dir of await candidateDirs(configDir, workDir)) {
    const raw = await readFile(join(dir, `${sessionId}.jsonl`), "utf8").catch(() => null);
    if (raw !== null) return toTranscriptMessages(parseLines(raw));
  }
  return null;
}
