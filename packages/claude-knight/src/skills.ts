import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { log } from "@roundtable/knight-core";

/**
 * Expose the operator's skill tree to Claude Code.
 *
 * The skill-filter sidecar lays skills out as /skills/<category>/<skill>/SKILL.md
 * (one symlinked category dir per entry in spec.skills). Claude Code discovers
 * user skills one level deep in $CLAUDE_CONFIG_DIR/skills/<skill>/SKILL.md, so
 * each skill dir is symlinked there. Runs before every task, which also picks up
 * git-sync updates and category changes without a restart.
 *
 * Name collisions across categories (the arsenal has e.g. shared/report-generator
 * and pentest/report-generator) keep the first by sorted category and link the
 * others as "<category>-<skill>". Only symlinks pointing into skillsDir are ever
 * removed, so skills a knight wrote for itself under the same dir survive.
 */
export interface SkillLinkResult {
  names: string[];
  added: number;
  removed: number;
}

export function discoverSkills(skillsDir: string): Array<{ name: string; path: string; category: string }> {
  if (!existsSync(skillsDir)) return [];
  const found: Array<{ name: string; path: string; category: string }> = [];
  const taken = new Set<string>();
  const categories = readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => d.name)
    .filter((n) => !n.startsWith("."))
    .sort();

  for (const category of categories) {
    const catPath = join(skillsDir, category);
    let entries;
    try {
      entries = readdirSync(catPath, { withFileTypes: true });
    } catch {
      continue; // dangling category symlink while git-sync swaps worktrees
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const skillPath = join(catPath, e.name);
      if (!existsSync(join(skillPath, "SKILL.md"))) continue;
      const name = taken.has(e.name) ? `${category}-${e.name}` : e.name;
      if (taken.has(name)) continue;
      taken.add(name);
      found.push({ name, path: skillPath, category });
    }
  }
  return found;
}

export function linkSkills(skillsDir: string, claudeConfigDir: string): SkillLinkResult {
  const target = join(claudeConfigDir, "skills");
  mkdirSync(target, { recursive: true });

  const wanted = new Map(discoverSkills(skillsDir).map((s) => [s.name, s.path]));
  let added = 0;
  let removed = 0;

  // Drop links we own that are stale or now point elsewhere.
  for (const name of readdirSync(target)) {
    const p = join(target, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (!st.isSymbolicLink()) continue;
    const dest = readlinkSync(p);
    if (!dest.startsWith(skillsDir + "/")) continue;
    if (wanted.get(name) !== dest) {
      unlinkSync(p);
      removed++;
    }
  }

  for (const [name, path] of wanted) {
    const p = join(target, name);
    if (existsSync(p) || isSymlink(p)) continue; // ours (already correct) or the knight's own
    symlinkSync(path, p);
    added++;
  }

  if (added || removed) log.info("Skills linked", { count: wanted.size, added, removed });
  return { names: [...wanted.keys()], added, removed };
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
