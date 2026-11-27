import path from "node:path";

/**
 * The skill a tool call activates: a `read` of `<skillsDir>/<category>/<skill>/SKILL.md`.
 * The pi SDK emits no event for a model reading a skill, so the read tool call is the signal
 * (its argument is `path`). Paths are resolved and anything outside `skillsDir` is ignored.
 */
export function skillFromToolCall(skillsDir: string, toolName: string, args: unknown): { skill: string; category: string } | undefined {
  if (toolName !== "read" || !args || typeof args !== "object") return undefined;
  const p = (args as { path?: unknown }).path;
  if (typeof p !== "string" || !p) return undefined;
  const root = path.resolve(skillsDir);
  const rel = path.relative(root, path.resolve(root, p));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const parts = rel.split(path.sep);
  if (parts.length !== 3 || parts[2] !== "SKILL.md") return undefined;
  return { category: parts[0]!, skill: parts[1]! };
}
