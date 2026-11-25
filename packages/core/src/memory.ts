import { cpSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";

/** Where a knight keeps its long-term memory. */
export interface MemoryPaths {
  /** True when the operator mounted a memory volume (KNIGHT_MEMORY_DIR). */
  volume: boolean;
  /** Directory holding MEMORY.md and memory/. */
  dir: string;
  /** Long-term memory file. */
  longTermFile: string;
  /** Directory of daily logs. */
  dailyLogDir: string;
  /** Daily log file name pattern shown to the model. */
  dailyLogPattern: string;
  /** Read-only root holding other knights' memory (KNIGHT_MEMORY_ROOT), if any. */
  root?: string;
}

/** Daily log file name: per pod when a memory volume is set so replicas never append to one file. */
export function dailyLogName(date: Date, host: string = hostname()): string {
  return `${date.toISOString().slice(0, 10)}-${host}.md`;
}

/**
 * Resolve memory paths. With no memoryDir they are the historical `/data` layout.
 * `dataDir` is the knight's workspace (default `/data`).
 */
export function resolveMemoryPaths(
  opts: { memoryDir?: string; memoryRoot?: string; dataDir?: string },
): MemoryPaths {
  const { memoryDir, memoryRoot } = opts;
  if (!memoryDir) {
    const dir = opts.dataDir ?? "/data";
    return {
      volume: false,
      dir,
      longTermFile: join(dir, "MEMORY.md"),
      dailyLogDir: join(dir, "memory"),
      dailyLogPattern: "memory/YYYY-MM-DD.md",
    };
  }
  return {
    volume: true,
    dir: memoryDir,
    longTermFile: join(memoryDir, "MEMORY.md"),
    dailyLogDir: join(memoryDir, "memory"),
    dailyLogPattern: `memory/YYYY-MM-DD-${hostname()}.md`,
    ...(memoryRoot ? { root: memoryRoot } : {}),
  };
}

/**
 * Prompt text describing the memory layout. Empty when no memory volume is configured,
 * so the prompt stays exactly as it was.
 */
export function memoryPromptSection(paths: MemoryPaths): string {
  if (!paths.volume) return "";
  const lines = [
    "<memory_layout>",
    "Your long-term memory is on a persistent memory volume; this overrides any /data paths in the instructions below.",
    `- Long-term memory: ${paths.longTermFile} (replace the whole file in one write, never leave it half-written)`,
    `- Daily logs: ${paths.dailyLogDir}/YYYY-MM-DD-<hostname>.md, one file per pod (yours: ${paths.dailyLogDir}/${dailyLogName(new Date())}); never append to another pod's file`,
    "- Session notes and scratch stay under /data.",
  ];
  if (paths.root) {
    lines.push(`Other knights' memory is under \`${paths.root}/<name>/\`; read it when useful, never write there.`);
  }
  lines.push("</memory_layout>");
  return lines.join("\n");
}

/** Filesystem steps of writeFileAtomic; overridable so tests can inject a failure between write and rename. */
export interface AtomicFsOps {
  write: (path: string, data: string) => void;
  rename: (from: string, to: string) => void;
}

const defaultAtomicOps: AtomicFsOps = {
  write: (p, d) => writeFileSync(p, d, "utf8"),
  rename: renameSync,
};

/**
 * Write `data` to `file` via a temp file and rename, so a concurrent reader never sees a partial file
 * and a crash or failure leaves the previous file intact (the temp file is removed on failure).
 */
export function writeFileAtomic(file: string, data: string, ops: AtomicFsOps = defaultAtomicOps): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    ops.write(tmp, data);
    ops.rename(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * One-time migration: if the memory volume has no MEMORY.md and the workspace has one, copy
 * MEMORY.md and memory/ across. Never overwrites existing files. Returns true when it copied.
 */
export function migrateMemory(opts: { memoryDir?: string; dataDir?: string }): boolean {
  const { memoryDir } = opts;
  if (!memoryDir) return false;
  const dataDir = opts.dataDir ?? "/data";
  const target = join(memoryDir, "MEMORY.md");
  const source = join(dataDir, "MEMORY.md");
  if (existsSync(target) || !existsSync(source)) return false;
  mkdirSync(memoryDir, { recursive: true });
  // Copy the daily logs first and MEMORY.md last (via rename): MEMORY.md's presence marks the migration as done.
  const sourceLogs = join(dataDir, "memory");
  if (existsSync(sourceLogs)) {
    cpSync(sourceLogs, join(memoryDir, "memory"), { recursive: true, force: false, errorOnExist: false });
  }
  const tmp = `${target}.${process.pid}.migrate.tmp`;
  cpSync(source, tmp);
  renameSync(tmp, target);
  log.info("Migrated long-term memory to the memory volume", { from: dataDir, to: memoryDir });
  return true;
}

/** Create the memory directories on the volume (no-op without one). */
export function ensureMemoryDirs(paths: MemoryPaths): void {
  if (paths.volume) mkdirSync(paths.dailyLogDir, { recursive: true });
}
