import os from "node:os";
import path from "node:path";

/**
 * Resolve a read path like pi's read tool (`resolveToCwd`): strip a leading `@`, expand `~`, resolve against the session cwd.
 * This is a subset of `resolveToCwd`: it does not normalise Unicode space characters in the path and does not handle `file://` URLs.
 * A path that only resolves to a skill under pi's full rules is therefore not recognised as an activation.
 */
function resolveReadPath(p: string, cwd: string): string {
  let s = p.startsWith("@") ? p.slice(1) : p;
  if (s === "~") s = os.homedir();
  else if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));
  return path.resolve(cwd, s);
}

/**
 * The skill a tool call activates: a `read` of `<skillsDir>/<category>/<skill>/SKILL.md`.
 * The pi SDK emits no event for a model reading a skill, so the read tool call is the signal
 * (its argument is `path`). Paths are resolved like the read tool does (against the session `cwd`, with `@` stripped and `~` expanded) and anything outside `skillsDir` is ignored.
 */
export function skillFromToolCall(skillsDir: string, toolName: string, args: unknown, cwd: string = skillsDir): { skill: string; category: string } | undefined {
  if (toolName !== "read" || !args || typeof args !== "object") return undefined;
  const p = (args as { path?: unknown }).path;
  if (typeof p !== "string" || !p) return undefined;
  const root = path.resolve(skillsDir);
  const rel = path.relative(root, resolveReadPath(p, cwd));
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  const parts = rel.split(path.sep);
  if (parts.length !== 3 || parts[2] !== "SKILL.md") return undefined;
  return { category: parts[0]!, skill: parts[1]! };
}
