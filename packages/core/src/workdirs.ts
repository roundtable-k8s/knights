import { chmod, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger.js";

/**
 * Remove a directory tree even when it holds read-only files/dirs (e.g. Go
 * envtest binaries). Adds owner write (+exec on dirs) before removing, and
 * never follows symlinks: links are unlinked, their targets left untouched.
 * Asynchronous on purpose: a task's tree can hold a cloned repo with
 * node_modules, and walking it synchronously blocked the event loop long enough
 * to miss the task's heartbeats, so the server dead-lettered a task that then
 * succeeded (#75).
 */
export async function forceRemoveTree(path: string): Promise<void> {
  const fix = async (p: string): Promise<void> => {
    let st;
    try {
      st = await lstat(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    try {
      await chmod(p, st.mode | (st.isDirectory() ? 0o700 : 0o200));
    } catch {
      /* best effort; rm reports real failures */
    }
    if (st.isDirectory()) for (const name of await readdir(p)) await fix(join(p, name));
  };
  await fix(path);
  await rm(path, { recursive: true, force: true });
}

export interface SweepOptions {
  /** Directories whose mtime is younger than this are kept. Default 24 h. */
  maxAgeMs?: number;
  /** Return true for a directory a running task owns; it is never removed. */
  isActive?: (dir: string) => boolean;
  /** Entry names to leave alone (e.g. ".warm"). */
  skip?: readonly string[];
}

/** Remove directories directly under `root` older than maxAgeMs that no running task owns. Returns the count removed. */
export async function sweepStaleDirs(root: string, opts: SweepOptions = {}): Promise<number> {
  const { maxAgeMs = 24 * 3600 * 1000, isActive, skip = [] } = opts;
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (skip.includes(name)) continue;
    const dir = join(root, name);
    if (isActive?.(dir)) continue;
    try {
      const st = await lstat(dir);
      if (!st.isDirectory() || Date.now() - st.mtimeMs < maxAgeMs) continue;
      await forceRemoveTree(dir);
      removed++;
    } catch (e) {
      log.warn("Could not sweep stale task working directory", { dir, error: String(e) });
    }
  }
  if (removed) log.info("Swept stale task working directories", { removed });
  return removed;
}
