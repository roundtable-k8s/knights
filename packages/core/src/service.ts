import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NatsConnection } from "@nats-io/transport-node";
import { Svcm, type Service } from "@nats-io/services";
import { log } from "./logger.js";
import { natsPrefix, subjectToken } from "./activity.js";

/** The NATS micro service name every knight pod registers under (`nats micro ls roundtable-knight`). */
export const SERVICE_NAME = "roundtable-knight";
/** Max size of the `skills` metadata JSON; descriptions are truncated first, then entries dropped. */
export const MAX_SKILLS_JSON_BYTES = 8 * 1024;

export interface SkillInfo {
  name: string;
  description: string;
  category: string;
}

/** Strip matching quotes from a YAML scalar. */
function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

/** Read `name` and `description` from SKILL.md frontmatter (single-line, quoted, or folded/literal block scalars). */
export function parseSkillFrontmatter(text: string): { name?: string; description?: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const lines = m[1]!.split(/\r?\n/);
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    const key = kv[1]!;
    const val = kv[2]!.trim();
    if (/^[>|][+-]?$/.test(val)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      out[key] = parts.join(" ");
    } else {
      out[key] = unquote(val);
    }
  }
  return out;
}

/**
 * Read the skill tree laid out by the skill-filter sidecar: `<dir>/<category>/<skill>/SKILL.md`.
 * Skills without a readable SKILL.md are skipped; the name falls back to the directory name.
 * Sorted by category then name so the list is stable between reads.
 */
export function readSkills(skillsDir: string): SkillInfo[] {
  if (!existsSync(skillsDir)) return [];
  const skills: SkillInfo[] = [];
  let categories: string[];
  try {
    categories = readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return [];
  }
  for (const category of categories.sort()) {
    let entries: string[];
    try {
      entries = readdirSync(join(skillsDir, category), { withFileTypes: true })
        .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith("."))
        .map((d) => d.name);
    } catch {
      continue; // dangling category symlink while git-sync swaps worktrees
    }
    for (const dir of entries.sort()) {
      try {
        const fm = parseSkillFrontmatter(readFileSync(join(skillsDir, category, dir, "SKILL.md"), "utf8"));
        skills.push({ name: fm?.name || dir, description: fm?.description ?? "", category });
      } catch {
        // no SKILL.md (or mid-swap): not a skill
      }
    }
  }
  return skills;
}

const byteLength = (s: string) => Buffer.byteLength(s, "utf8");

/** Serialise skills for metadata, within `maxBytes`: cap description length (largest cap that fits), then drop entries. */
export function skillsMetadataJson(skills: SkillInfo[], maxBytes = MAX_SKILLS_JSON_BYTES): string {
  const render = (list: SkillInfo[], cap: number) =>
    JSON.stringify(list.map((s) => (s.description.length > cap ? { ...s, description: s.description.slice(0, cap) } : s)));
  const longest = skills.reduce((m, s) => Math.max(m, s.description.length), 0);
  let list = skills;
  while (byteLength(render(list, 0)) > maxBytes && list.length > 0) list = list.slice(0, -1);
  if (byteLength(render(list, longest)) <= maxBytes) return render(list, longest);
  let lo = 0; // fits
  let hi = longest; // does not fit
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (byteLength(render(list, mid)) <= maxBytes) lo = mid;
    else hi = mid;
  }
  return render(list, lo);
}

/** The task domain from the subscribed subjects: `<prefix>.tasks.<domain>.>` -> `<domain>`; "" if there is none. */
export function domainFromTopics(topics: string[]): string {
  for (const t of topics) {
    const m = /\.tasks\.([^.>*]+)/.exec(t);
    if (m) return m[1]!;
  }
  return "";
}

/** The table name: ROUNDTABLE_TABLE (set by the operator), else the NATS prefix. */
export function tableName(env: NodeJS.ProcessEnv, config: { natsResultsPrefix: string }): string {
  return env["ROUNDTABLE_TABLE"] || natsPrefix(config);
}

export interface KnightStats {
  activeTasks: number;
  maxConcurrentTasks: number;
  tasksTotal: number;
  tasksFailed: number;
  /** ISO timestamp of the last finished task, or null. */
  lastTaskAt: string | null;
}

export interface KnightServiceOptions {
  nc: NatsConnection;
  knightName: string;
  table: string;
  domain: string;
  model: string;
  /** "pi-knight" | "claude-knight". */
  runtime: string;
  /** The runtime's package version. */
  version: string;
  pod: string;
  /** Skill tree root, normally /skills. */
  skillsDir: string;
  maxConcurrentTasks: number;
  getActive(): number;
  /** Counters since start: all finished tasks and those that failed (error or lost). */
  getCounts(): Promise<{ total: number; failed: number }> | { total: number; failed: number };
}

export interface KnightService {
  /** Re-read the skill tree; if the list changed, stop and re-add the service. */
  refreshSkills(): Promise<boolean>;
  /** Record that a task just finished (feeds `lastTaskAt`). */
  markTaskFinished(): void;
  /** Stop answering PING/INFO/STATS. Safe to call twice. */
  stop(): Promise<void>;
  /** The current INFO metadata. */
  metadata(): Record<string, string>;
}

/** Counts from the shared prom-client `tasksTotal` counter (labels: knight, status). */
export async function countsFromMetrics(
  tasksTotal: { get(): Promise<{ values: Array<{ value: number; labels: Record<string, unknown> }> }> },
  knight: string,
): Promise<{ total: number; failed: number }> {
  let total = 0;
  let failed = 0;
  for (const v of (await tasksTotal.get()).values) {
    if (v.labels["knight"] !== knight) continue;
    total += v.value;
    if (v.labels["status"] === "error" || v.labels["status"] === "lost") failed += v.value;
  }
  return { total, failed };
}

/**
 * Register this pod as a NATS micro service (`$SRV.PING|INFO|STATS.roundtable-knight`) for
 * discovery, liveness and load. Task dispatch stays on JetStream; the only endpoint is a
 * read-only card on `$RT.<table>.<knight>.card` that returns the INFO metadata.
 */
export async function startKnightService(opts: KnightServiceOptions): Promise<KnightService> {
  let lastTaskAt: string | null = null;
  let skillsJson = skillsMetadataJson(readSkills(opts.skillsDir));
  let svc: Service | null = null;
  let stopped = false;

  const metadata = (): Record<string, string> => ({
    table: opts.table,
    knight: opts.knightName,
    domain: opts.domain,
    model: opts.model,
    runtime: opts.runtime,
    pod: opts.pod,
    skills: skillsJson,
  });

  async function stats(): Promise<KnightStats> {
    const { total, failed } = await opts.getCounts();
    return {
      activeTasks: opts.getActive(),
      maxConcurrentTasks: opts.maxConcurrentTasks,
      tasksTotal: total,
      tasksFailed: failed,
      lastTaskAt,
    };
  }

  async function add(): Promise<Service> {
    const s = await new Svcm(opts.nc).add({
      name: SERVICE_NAME,
      version: opts.version,
      description: `${opts.knightName}${opts.domain ? ` (${opts.domain})` : ""}`,
      metadata: metadata(),
      statsHandler: async () => stats(),
    });
    const cardSubject = `$RT.${subjectToken(opts.table)}.${subjectToken(opts.knightName)}.card`;
    s.addEndpoint("card", {
      subject: cardSubject,
      // Unique per pod name; read-only. It must never take tasks.
      handler: (err, msg) => {
        if (err) return;
        msg.respond(JSON.stringify(metadata()));
      },
    });
    return s;
  }

  svc = await add();
  log.info("NATS micro service registered", { name: SERVICE_NAME, id: svc.info().id });

  return {
    metadata,
    markTaskFinished() {
      lastTaskAt = new Date().toISOString();
    },
    async refreshSkills() {
      if (stopped) return false;
      let next: string;
      try {
        next = skillsMetadataJson(readSkills(opts.skillsDir));
      } catch (e) {
        log.warn("Skill refresh failed", { error: String(e) });
        return false;
      }
      if (next === skillsJson) return false;
      skillsJson = next;
      try {
        await svc?.stop();
        if (!stopped) svc = await add();
        log.info("NATS micro service re-registered: skills changed");
      } catch (e) {
        log.warn("NATS micro service re-register failed", { error: String(e) });
      }
      return true;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await svc?.stop().catch((e) => log.warn("NATS micro service stop failed", { error: String(e) }));
    },
  };
}

/** The `version` of the nearest package.json above `fromUrl` (pass `import.meta.url` from `src/` or `dist/`). */
export function readPackageVersion(fromUrl: string): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", fromUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
