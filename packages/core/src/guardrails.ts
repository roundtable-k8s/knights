/**
 * Tool guardrails shared by both runtimes (pi-knight extension, claude-knight
 * SDK and CLI hooks): blocked bash commands and writes that carry a secret.
 */
import { containsSecret } from "./activity.js";

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

/** Reason a bash command must be blocked, or undefined when it is allowed. */
export function checkBashCommand(command: string): string | undefined {
  return BLOCKED_BASH_PATTERNS.find(({ pattern }) => pattern.test(command))?.reason;
}

/**
 * Token-shaped secrets only (keys, PATs, JWTs, PEM blocks): this text goes to and from the
 * model, where flagging `password=...` context would block ordinary code.
 */
export const isTokenSecret = (text: string): boolean => containsSecret(text, "tokens");

/**
 * Block Claude Code Write (`content`), Edit (`new_string`) and MultiEdit (each edit's
 * `new_string`) whose new text contains a token-shaped secret. Returns the reason or undefined.
 */
export function checkWriteContent(toolName: string, input: unknown): string | undefined {
  const i = (input ?? {}) as { content?: unknown; new_string?: unknown; edits?: unknown };
  let texts: unknown[] = [];
  if (toolName === "Write") texts = [i.content];
  else if (toolName === "Edit") texts = [i.new_string];
  else if (toolName === "MultiEdit" && Array.isArray(i.edits)) {
    texts = i.edits.map((e) => (e as { new_string?: unknown } | null)?.new_string);
  }
  return texts.some((t) => typeof t === "string" && isTokenSecret(t)) ? SECRET_IN_CONTENT : undefined;
}
