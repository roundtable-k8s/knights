/**
 * Tool guardrails shared by both runtimes (pi-knight extension, claude-knight
 * SDK and CLI hooks): blocked bash commands and writes that carry a secret.
 *
 * Intended over-blocks (fail-safe, pinned in tests/guardrails.test.ts):
 * - `git rm -r /` and `find / -exec rm -r {} +` are blocked: `rm` is matched as a token anywhere
 *   in a segment, and a recursive flag plus a bare `/` target is never legitimate in a knight pod.
 * - Quoted text is not parsed, so a heredoc or `echo` body that mentions `git push -f` is blocked
 *   too. Workaround: write review/PR text with the Write tool, then pass it by file (`--body-file`).
 */
import { containsSecret } from "./activity.js";
import { gitPushArgs } from "./structured.js";

/** Bash commands that should be blocked outright. */
export const BLOCKED_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(?:\s|$|\*)/, reason: "Recursive delete at root level" },
  // Match the flag as a whole token: not a branch like `fix-f`, and --force-with-lease stays allowed.
  // Known residual false positive (deliberate fail-safe): the patterns scan the raw command text, so
  // `git push -f` appearing as an argument (e.g. `echo "git push -f"`) is blocked too.
  // The short-flag check (`-f` anywhere in the flag cluster) is deliberately broad.
  { pattern: /\bgit\s+push\b[^;&|\n]*\s--force(?=\s|$)/, reason: "Force push without lease (use --force-with-lease or new commits)" },
  { pattern: /\bgit\s+push\b[^;&|\n]*\s-[a-zA-Z]*f[a-zA-Z]*(?=\s|$)/, reason: "Force push (use new commits instead)" },
  { pattern: /\bchmod\s+(-R\s+)?777\b/, reason: "World-writable permissions" },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: "Direct device write" },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: "Filesystem format" },
];

/** Shared prefix of every guardrail denial reason (both runtimes); the claude-knight CLI runtime counts blocked calls by it. */
export const BLOCK_REASON_PREFIX = "Blocked by knight safety policy: ";

/** Reason `secret_in_content` for writes that carry a token-shaped secret. */
export const SECRET_IN_CONTENT = "secret_in_content";

const LONG_FORCE_REASON = "Force push without lease (use --force-with-lease or new commits)";
const SHORT_FORCE_REASON = "Force push (use new commits instead)";
const ROOT_DELETE_REASON = "Recursive delete at root level";

/** Reason a bash segment is a force push, or undefined. Token-level, so flag order and `git -C dir` do not matter. */
function forcePushReason(segment: string): string | undefined {
  const args = gitPushArgs(segment);
  if (!args) return undefined;
  if (args.includes("--force")) return LONG_FORCE_REASON;
  // A short-flag cluster containing `f` (`-f`, `-uf`) or a `+refspec` (`+main`, `+HEAD:main`) also forces.
  if (args.some((t) => /^-[a-zA-Z]*f[a-zA-Z]*$/.test(t) || (t.startsWith("+") && t.length > 1))) return SHORT_FORCE_REASON;
  return undefined;
}

/** True when a bash segment is `rm` with a recursive flag whose target is exactly `/` or `/*`. */
function isRootDeleteSegment(segment: string): boolean {
  const tokens = segment.trim().split(/\s+/);
  if (!tokens.includes("rm")) return false;
  const recursive = tokens.some((t) => t === "--recursive" || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(t));
  return recursive && tokens.some((t) => t === "/" || t === "/*");
}

/** Reason a bash command must be blocked, or undefined when it is allowed. */
export function checkBashCommand(command: string): string | undefined {
  const pattern = BLOCKED_BASH_PATTERNS.find(({ pattern }) => pattern.test(command));
  if (pattern) return pattern.reason;
  // Split on the same separators as prsFromBash so each simple command is checked on its own.
  const segments = command.split(/&&|\|\||;|\||\n/);
  for (const segment of segments) {
    const reason = forcePushReason(segment) ?? (isRootDeleteSegment(segment) ? ROOT_DELETE_REASON : undefined);
    if (reason) return reason;
  }
  return undefined;
}

/**
 * Token-shaped secrets only (keys, PATs, JWTs, PEM blocks): this text goes to and from the
 * model, where flagging `password=...` context would block ordinary code.
 */
export const isTokenSecret = (text: string): boolean => containsSecret(text, "tokens");

/**
 * Block file writes whose new text contains a token-shaped secret. Understands Claude Code
 * Write (`content`), Edit (`new_string`) and MultiEdit (each edit's `new_string`), and pi's
 * `write` (`content`) and `edit` (each `edits[].newText`, plus the legacy top-level `newText`).
 * Returns the reason or undefined.
 */
export function checkWriteContent(toolName: string, input: unknown): string | undefined {
  const i = (input ?? {}) as { content?: unknown; new_string?: unknown; newText?: unknown; edits?: unknown };
  const field = (e: unknown, key: string): unknown => (e as Record<string, unknown> | null)?.[key];
  const editTexts = (key: string): unknown[] => (Array.isArray(i.edits) ? i.edits.map((e) => field(e, key)) : []);
  let texts: unknown[] = [];
  if (toolName === "Write" || toolName === "write") texts = [i.content];
  else if (toolName === "Edit") texts = [i.new_string];
  else if (toolName === "MultiEdit") texts = editTexts("new_string");
  else if (toolName === "edit") texts = [i.newText, ...editTexts("newText")];
  return texts.some((t) => typeof t === "string" && isTokenSecret(t)) ? SECRET_IN_CONTENT : undefined;
}
