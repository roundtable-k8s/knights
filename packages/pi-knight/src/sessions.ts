/**
 * Session lifecycle helpers: per-task/per-run session keying and on-disk retention.
 *
 * A knight holds exactly one live AgentSession in memory. Chain tasks carry the
 * operator-assigned run id (TaskPayload.RunID, JSON `runId`); steps of one run share a
 * session, and a task from a new run gets a fresh one so context never bleeds between
 * runs (#31). Tasks without a runId (ad-hoc NATS tasks) each get a fresh session too
 * (#53); long-term memory lives in files on the PVC, not in the live session. Every fresh
 * session the pi SDK persists becomes a JSONL file under <agentDir>/sessions, so
 * per-run sessions would grow the PVC without bound — pruneSessionFiles caps that.
 */
import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { dataPaths } from "./config.js";

// Root of the persisted per-session JSONL files (pi SDK writes under <agentDir>/sessions;
// agentDir is KNIGHT_DATA_DIR). KNIGHT_SESSIONS_ROOT overrides it. Read on each call.
export const sessionsRoot = (): string => dataPaths().sessionsRoot;

export type RunSessionAction =
  /** Keep using the current session (same run id, or no session yet). */
  | "reuse"
  /** New run or run-less task, but the current session was never prompted — take it over as-is. */
  | "adopt"
  /** New run or run-less task with a used session — dispose it and start a fresh one. */
  | "reset";

/**
 * Decide what to do with the live session when a task arrives.
 *
 * - No session yet: reuse (one is created).
 * - Same runId as the current session: reuse — steps of one chain run share context.
 * - Different runId, or no runId at all (ad-hoc tasks never carry one): reset, so
 *   unrelated tasks never share context (#53). Exception: a pristine session (never
 *   prompted, no history) is adopted instead — equivalent, and keeps startup pre-warm
 *   useful.
 */
export function decideRunSession(opts: {
  runId: string | undefined;
  currentRunId: string | undefined;
  hasSession: boolean;
  sessionPristine: boolean;
}): RunSessionAction {
  const { runId, currentRunId, hasSession, sessionPristine } = opts;
  if (!hasSession || (runId !== undefined && runId !== "" && runId === currentRunId)) return "reuse";
  return sessionPristine ? "adopt" : "reset";
}

export interface SessionFile {
  id: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
}

// A persisted session's public id is the uuid embedded in its filename
// (`<iso-timestamp>_<uuid>.jsonl`).
export function sessionIdFromFilename(name: string): string {
  const stem = name.replace(/\.jsonl$/, "");
  const us = stem.lastIndexOf("_");
  return us >= 0 ? stem.slice(us + 1) : stem;
}

export interface SessionScan {
  files: SessionFile[];
  /** Set when the sessions root exists but cannot be read (a missing root is not an error). */
  rootError?: string;
}

/**
 * Scan every persisted session file under `root` (one subdir per cwd), newest first by
 * mtime. The root is read once; a missing root yields no files and no error.
 */
export async function scanSessionFiles(root: string = sessionsRoot()): Promise<SessionScan> {
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch (err) {
    return codeOf(err) === "ENOENT" ? { files: [] } : { files: [], rootError: errorMessage(err) };
  }
  const dirs = dirents.filter((d) => d.isDirectory()).map((d) => join(root, d.name));
  // Defensive: also consider .jsonl files sitting directly in the root.
  if (dirents.some((d) => d.isFile() && d.name.endsWith(".jsonl"))) dirs.push(root);

  const files: SessionFile[] = [];
  for (const dir of dirs) {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      try {
        const st = await stat(path);
        files.push({ id: sessionIdFromFilename(name), path, sizeBytes: st.size, mtimeMs: st.mtimeMs });
      } catch {
        // file vanished between readdir and stat — skip
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { files };
}

/**
 * List every persisted session file under `root`, newest first by mtime.
 * Returns [] if the dir doesn't exist yet or cannot be read.
 */
export async function listSessionFiles(root: string = sessionsRoot()): Promise<SessionFile[]> {
  return (await scanSessionFiles(root)).files;
}

export interface RetentionPolicy {
  /** Keep at most this many session files (newest first). 0 disables the count cap. */
  maxFiles: number;
  /** Delete session files not modified for this long. 0 disables the age cap. */
  maxAgeMs: number;
}

/**
 * Pure selection of which session files to delete under `policy`.
 * `files` must be sorted newest first; paths in `keep` (the live session) are never
 * selected and count toward `maxFiles` first, so the cap includes the live session.
 */
export function selectSessionsToPrune(
  files: SessionFile[],
  policy: RetentionPolicy,
  keep: ReadonlySet<string>,
  now: number,
): SessionFile[] {
  const out: SessionFile[] = [];
  let kept = files.filter((f) => keep.has(f.path)).length;
  for (const f of files) {
    if (keep.has(f.path)) continue;
    const tooOld = policy.maxAgeMs > 0 && now - f.mtimeMs > policy.maxAgeMs;
    const overCount = policy.maxFiles > 0 && kept >= policy.maxFiles;
    if (tooOld || overCount) out.push(f);
    else kept++;
  }
  return out;
}

export interface PruneResult {
  /** Paths that were deleted. */
  removed: string[];
  /** Paths selected for deletion that could not be deleted, with the error message. */
  failed: Array<{ path: string; error: string }>;
  /** Set when the sessions root exists but cannot be read (e.g. EACCES). */
  rootError?: string;
}

/**
 * Apply `policy` to the session files under `root`. Returns what was deleted and what
 * could not be (so the caller can report a volume that is filling up instead of
 * silently keeping every file).
 */
export async function pruneSessionFiles(
  policy: RetentionPolicy,
  keep: ReadonlySet<string> = new Set(),
  root: string = sessionsRoot(),
  now: number = Date.now(),
): Promise<PruneResult> {
  const result: PruneResult = { removed: [], failed: [] };
  if (policy.maxFiles <= 0 && policy.maxAgeMs <= 0) return result;
  const scan = await scanSessionFiles(root);
  if (scan.rootError !== undefined) {
    result.rootError = scan.rootError;
    return result;
  }
  const victims = selectSessionsToPrune(scan.files, policy, keep, now);
  for (const v of victims) {
    try {
      await unlink(v.path);
      result.removed.push(v.path);
    } catch (err) {
      // Already gone is not a failure; anything else means the file stays on disk.
      if (codeOf(err) === "ENOENT") continue;
      result.failed.push({ path: v.path, error: errorMessage(err) });
    }
  }
  return result;
}

/**
 * Decide the retention warning for a prune result, given the key of the last warning
 * logged. `next` is the key to remember; `warn` is set only when the problem is new, so
 * an undeletable volume logs once instead of on every run. A clean prune clears the key.
 */
export function pruneWarning(
  result: PruneResult,
  last: string | undefined,
): { next: string | undefined; warn?: { message: string; fields: Record<string, unknown> } } {
  if (result.rootError !== undefined) {
    const next = `root:${result.rootError}`;
    if (next === last) return { next };
    return {
      next,
      warn: { message: "Session retention cannot read the sessions root", fields: { error: result.rootError } },
    };
  }
  const first = result.failed[0];
  if (first === undefined) return { next: undefined };
  const next = `failed:${first.error}`;
  if (next === last) return { next };
  return {
    next,
    warn: {
      message: "Could not delete old session files; the sessions volume will keep growing",
      fields: { count: result.failed.length, path: first.path, error: first.error },
    },
  };
}

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException)?.code;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
