/**
 * Memory management for pi-knight — session notes, compaction hooks, and scratch space.
 *
 * Implements a 3-layer memory hierarchy:
 * 1. Custom compaction prompt — preserves knight-specific context during auto-compaction
 * 2. Session notes — structured file updated after every task, survives compaction
 * 3. Long-term memory — MEMORY.md + daily logs (handled by AGENTS.md instructions)
 *
 * Inspired by Claude Code's session memory template and Anthropic's context engineering blog.
 */
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { dataPaths, type KnightConfig } from "./config.js";
import { compactionsTotal, llmRetriesTotal } from "./runtime-metrics.js";
import { log, sweepStaleTempFiles, writeFileAtomic, type AtomicFsOps } from "@roundtable/knight-core";

// ─── Directories ────────────────────────────────────────────────

// KNIGHT_DATA_DIR (default /data); read lazily so env set after import applies.
const DATA_DIR = () => dataPaths().dataDir;
const SESSION_NOTES_DIR = () => `${DATA_DIR()}/session-notes`;
const SESSION_NOTES_FILE = () => `${SESSION_NOTES_DIR()}/current.md`;
const SCRATCH_DIR = () => `${DATA_DIR()}/scratch`;

/**
 * Subscribe to Pi SDK compaction/retry events for observability only.
 *
 * This logs compaction_start/end and auto_retry_start/end — it does NOT modify
 * compaction behavior or inject instructions. Knight-specific context is preserved
 * via the session-notes file (see updateSessionNotes), not here.
 */
export function setupCompactionHook(session: AgentSession, config: KnightConfig): void {
  const listener = (event: AgentSessionEvent): void => {
    if (event.type === "compaction_start") {
      log.info("Context compaction starting", {
        knight: config.knightName,
        reason: event.reason,
      });
    }
    if (event.type === "compaction_end") {
      compactionsTotal.inc({ reason: String(event.reason), outcome: event.aborted ? "aborted" : "completed" });
      log.info("Context compaction complete", {
        knight: config.knightName,
        reason: event.reason,
        aborted: event.aborted,
        hasResult: !!event.result,
        willRetry: event.willRetry,
      });
    }
    if (event.type === "auto_retry_start") {
      log.warn("LLM auto-retry triggered", {
        knight: config.knightName,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        error: event.errorMessage,
      });
    }
    if (event.type === "auto_retry_end") {
      llmRetriesTotal.inc({ outcome: event.success ? "succeeded" : "exhausted" });
      if (event.success) {
        log.info("LLM auto-retry succeeded", { knight: config.knightName, attempt: event.attempt });
      } else {
        log.error("LLM auto-retry exhausted", {
          knight: config.knightName,
          attempt: event.attempt,
          finalError: event.finalError,
        });
      }
    }
  };
  session.subscribe(listener);

  log.info("Session hooks installed (compaction + retry observability)");
}

// ─── Session Notes ──────────────────────────────────────────────

// Per-path promise chains: read-modify-write of a notes file must not interleave within this process.
const WORKLOG_MAX_ENTRIES = 50;
const notesLocks = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier call for the same `key` has settled (failures do not block the queue). */
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = notesLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  notesLocks.set(key, tail);
  void tail.then(() => {
    if (notesLocks.get(key) === tail) notesLocks.delete(key);
  });
  return run;
}

/**
 * Update session notes after each task.
 *
 * Serialised per file (concurrent tasks) and written atomically (temp file + rename).
 *
 * This is the "short-term memory" layer — a structured file that persists
 * across context compaction. The "Current State" section is critical because
 * after compaction, the model loses what it was just working on.
 *
 * Based on Claude Code's session memory template (data-session-memory-template.md).
 */
export async function updateSessionNotes(
  knightName: string,
  task: string,
  result: string,
  fsOps?: AtomicFsOps,
): Promise<void> {
  return withLock(SESSION_NOTES_FILE(), () => updateSessionNotesLocked(knightName, task, result, fsOps));
}

async function updateSessionNotesLocked(
  knightName: string,
  task: string,
  result: string,
  fsOps?: AtomicFsOps,
): Promise<void> {
  // Ensure directories exist
  await ensureDir(SESSION_NOTES_DIR());
  await ensureDir(SCRATCH_DIR());
  sweepStaleTempFiles(SESSION_NOTES_DIR());

  const now = new Date().toISOString();
  // Free text may contain lines that look like headings; escape them so they are never read back as sections.
  const rawTaskPreview = task.length > 200 ? task.slice(0, 200) + "…" : task;
  const taskPreview = escapeHeadingLines(rawTaskPreview);
  const resultPreview = escapeHeadingLines(result.length > 500 ? result.slice(0, 500) + "…" : result);

  // Read existing notes if any
  let existing = "";
  try {
    existing = await readFile(SESSION_NOTES_FILE(), "utf-8");
  } catch {
    // File doesn't exist yet — that's fine
  }

  // Extract existing sections to preserve non-current-state content
  const previousLearnings = extractSection(existing, "Learnings");
  const previousErrors = extractSection(existing, "Errors & Corrections");
  // Worklog accumulates (bounded) so that every task's entry survives; lost updates would drop lines here.
  const previousWorklog = extractSection(existing, "Worklog").split("\n").filter((l) => l.startsWith("- "));
  const worklog = [...previousWorklog, `- ${now}: ${(rawTaskPreview.split("\n")[0] ?? "").slice(0, 80)} → result (${result.length} chars)`]
    .slice(-WORKLOG_MAX_ENTRIES)
    .join("\n");

  const notes = `# Current State
_Last updated: ${now}_
_Knight: ${knightName}_

**Most recent task:** ${taskPreview}

**Result summary:** ${resultPreview}

# Task Specification
${taskPreview}

# Files and Functions
_Updated by knight during task execution — check daily logs for details._

# Errors & Corrections
${previousErrors || "_None recorded yet._"}

# Learnings
${previousLearnings || "_None recorded yet._"}

# Key Results
${resultPreview}

# Worklog
${worklog}
`;

  writeFileAtomic(SESSION_NOTES_FILE(), notes, fsOps);
  log.debug("Session notes updated", {
    knight: knightName,
    file: SESSION_NOTES_FILE(),
    size: notes.length,
  });
}

// ─── Helpers ────────────────────────────────────────────────────

async function ensureDir(dir: string): Promise<void> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
    log.debug("Created directory", { dir });
  }
}

/** Top-level sections of the session-notes template, in the order they are written. */
const SESSION_NOTES_SECTIONS = [
  "Current State",
  "Task Specification",
  "Files and Functions",
  "Errors & Corrections",
  "Learnings",
  "Key Results",
  "Worklog",
];

/** Escape lines starting with `#` so free text cannot be read back as a top-level heading. */
function escapeHeadingLines(text: string): string {
  return text.replace(/^#/gm, "\\#");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract a section from markdown by header name.
 * Returns the content between the header and the next top-level header.
 *
 * The template's headings are located in order, so text inside an earlier section that
 * happens to contain a lookalike heading (e.g. a task spec with a "# Learnings" line) is skipped.
 */
function extractSection(markdown: string, sectionName: string): string {
  const order = SESSION_NOTES_SECTIONS.indexOf(sectionName);
  const walk = order >= 0 ? SESSION_NOTES_SECTIONS.slice(0, order + 1) : [sectionName];
  let cursor = 0;
  let start = -1;
  for (const name of walk) {
    const heading = new RegExp(`^#[ \\t]+${escapeRegExp(name)}[ \\t]*$`, "gm");
    heading.lastIndex = cursor;
    let match = heading.exec(markdown);
    if (match && name === sectionName && order === SESSION_NOTES_SECTIONS.length - 1) {
      // Last template section: anything before the real heading may be an unescaped lookalike in older notes.
      for (let next = heading.exec(markdown); next; next = heading.exec(markdown)) match = next;
    }
    if (!match) {
      if (name === sectionName) return "";
      continue; // a template section missing from older notes does not stop the walk
    }
    cursor = match.index + match[0].length;
    if (name === sectionName) start = cursor;
  }
  const nextTop = /^#[ \t]+/gm;
  nextTop.lastIndex = start;
  const next = nextTop.exec(markdown);
  return markdown.slice(start, next ? next.index : markdown.length).trim();
}
