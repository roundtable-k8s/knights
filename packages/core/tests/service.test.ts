import { strict as assert } from "node:assert";
import { spawn, type ChildProcess, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import {
  countsFromMetrics,
  domainFromTopics,
  parseSkillFrontmatter,
  readSkills,
  skillsMetadataJson,
  startKnightService,
  type KnightService,
  type SkillInfo,
} from "../src/service.ts";
import { createKnightMetrics } from "../src/metrics.ts";
import { createShutdown } from "../src/drain.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "skills");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dec = new TextDecoder();

describe("skills metadata", () => {
  it("parses frontmatter: quoted, plain and folded scalars", () => {
    assert.deepEqual(parseSkillFrontmatter('---\nname: a\ndescription: "b c"\n---\nx'), { name: "a", description: "b c" });
    assert.deepEqual(parseSkillFrontmatter("---\ndescription: >\n  one\n  two\n---\n"), { description: "one two" });
    assert.equal(parseSkillFrontmatter("no frontmatter"), null);
  });

  it("reads <category>/<skill>/SKILL.md, falling back to the dir name", () => {
    assert.deepEqual(readSkills(FIXTURE), [
      { name: "nmap-scan", description: "Scan hosts with nmap", category: "sec" },
      { name: "plain", description: "Folded description over two lines", category: "sec" },
      { name: "report-generator", description: "Make reports", category: "shared" },
    ]);
    assert.deepEqual(readSkills("/nonexistent/skills"), []);
  });

  it("caps the JSON at 8 KB, truncating descriptions before dropping skills", () => {
    const skills: SkillInfo[] = Array.from({ length: 100 }, (_, i) => ({ name: `s${i}`, description: "d".repeat(500), category: "c" }));
    const json = skillsMetadataJson(skills);
    assert.ok(Buffer.byteLength(json) <= 8192);
    const parsed = JSON.parse(json) as SkillInfo[];
    assert.equal(parsed.length, 100, "all skills kept");
    assert.ok(parsed.every((s) => s.description.length < 500));
    const many: SkillInfo[] = Array.from({ length: 2000 }, (_, i) => ({ name: `skill-${i}`, description: "x", category: "c" }));
    assert.ok(Buffer.byteLength(skillsMetadataJson(many)) <= 8192);
  });

  it("derives the domain from the task subject", () => {
    assert.equal(domainFromTopics(["fleet-a.tasks.security.>"]), "security");
    assert.equal(domainFromTopics(["x"]), "");
  });
});

const NATS_BIN = process.env["NATS_SERVER_BIN"] ?? ["/usr/local/bin/nats-server", "/usr/bin/nats-server"].find(existsSync) ?? "nats-server";
const hasBin = (bin: string) => !spawnSync(bin, ["--version"]).error;

describe("knight micro service against a real nats-server", { skip: !hasBin(NATS_BIN) && "nats-server not found (set NATS_SERVER_BIN)" }, () => {
  let proc: ChildProcess;
  let client: NatsConnection;
  let nc: NatsConnection;
  let skillsDir: string;
  let svc: KnightService;
  let active = 1;
  let shutdownDone = false;
  const metrics = createKnightMetrics({ runtime: "pi-knight", knight: "Tester" });
  const port = 4800 + Math.floor(Math.random() * 500);
  const url = `nats://127.0.0.1:${port}`;

  const request = async (subject: string, timeout = 1000) => JSON.parse(dec.decode((await client.request(subject, "", { timeout })).data)) as Record<string, unknown>;

  before(async () => {
    skillsDir = mkdtempSync(join(tmpdir(), "skills-"));
    cpSync(FIXTURE, skillsDir, { recursive: true });
    proc = spawn(NATS_BIN, ["-p", String(port)], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try { client = await connect({ servers: url }); break; } catch { await sleep(100); }
    }
    nc = await connect({ servers: url });
    metrics.tasksTotal.labels("success").inc(3);
    metrics.tasksTotal.labels("error").inc();
    svc = await startKnightService({
      nc,
      knightName: "Tester",
      table: "fleet-a",
      domain: "security",
      model: "m1",
      runtime: "pi-knight",
      version: "1.2.3",
      pod: "tester-0",
      skillsDir,
      maxConcurrentTasks: 2,
      getActive: () => active,
      getCounts: () => countsFromMetrics(metrics.tasksTotal, "Tester"),
    });
  });

  after(async () => {
    await svc?.stop();
    await nc?.close().catch(() => {});
    await client?.close().catch(() => {});
    proc?.kill();
    rmSync(skillsDir, { recursive: true, force: true });
  });

  it("answers INFO with table, knight and skills from the /skills tree", async () => {
    const info = await request("$SRV.INFO.roundtable-knight");
    assert.equal(info["name"], "roundtable-knight");
    assert.equal(info["version"], "1.2.3");
    assert.equal(info["description"], "Tester (security)");
    const md = info["metadata"] as Record<string, string>;
    assert.deepEqual({ ...md, skills: undefined }, {
      table: "fleet-a", knight: "Tester", domain: "security", model: "m1", runtime: "pi-knight", pod: "tester-0", skills: undefined,
    });
    assert.deepEqual((JSON.parse(md["skills"]!) as SkillInfo[]).map((s) => s.name), ["nmap-scan", "plain", "report-generator"]);
  });

  it("answers STATS with the task counters", async () => {
    svc.markTaskFinished();
    const stats = await request("$SRV.STATS.roundtable-knight");
    const data = (stats["endpoints"] as Array<{ data?: Record<string, unknown> }>).find((e) => e.data)!.data!;
    assert.equal(data["activeTasks"], 1);
    assert.equal(data["maxConcurrentTasks"], 2);
    assert.equal(data["tasksTotal"], 4);
    assert.equal(data["tasksFailed"], 1);
    assert.match(String(data["lastTaskAt"]), /^\d{4}-\d\d-\d\dT/);
  });

  it("serves the card on $RT.<table>.<knight>.card", async () => {
    const card = await request("$RT.fleet-a.Tester.card");
    assert.equal(card["knight"], "Tester");
    assert.equal(card["table"], "fleet-a");
  });

  it("re-adds the service when the skill tree changes, and not otherwise", async () => {
    assert.equal(await svc.refreshSkills(), false);
    mkdirSync(join(skillsDir, "sec", "new"));
    writeFileSync(join(skillsDir, "sec", "new", "SKILL.md"), "---\nname: brand-new\ndescription: fresh\n---\n");
    assert.equal(await svc.refreshSkills(), true);
    const md = (await request("$SRV.INFO.roundtable-knight"))["metadata"] as Record<string, string>;
    assert.ok((JSON.parse(md["skills"]!) as SkillInfo[]).some((s) => s.name === "brand-new"));
    assert.equal((await request("$RT.fleet-a.Tester.card"))["knight"], "Tester");
  });

  it("drops out of PING at once on drain, before NATS is drained", async () => {
    assert.ok(await request("$SRV.PING.roundtable-knight"), "alive before drain");
    const order: string[] = [];
    active = 0;
    const shutdown = createShutdown({
      setDraining: () => {},
      stopService: async () => { await svc.stop(); order.push("stopService"); },
      stopPulling: async () => { order.push("stopPulling"); },
      getActive: () => active,
      maxWaitMs: 100,
      drainNats: async () => { order.push("drainNats"); },
      exit: () => { shutdownDone = true; },
    });
    await shutdown("SIGTERM");
    assert.ok(shutdownDone);
    assert.deepEqual(order, ["stopService", "stopPulling", "drainNats"]);
    await assert.rejects(client.request("$SRV.PING.roundtable-knight", "", { timeout: 300 }));
  });
});
