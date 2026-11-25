// Tasks during a pod replacement (#75), against a real nats-server: a task delivered to a
// stopping pod's outstanding pull request, a task whose ack deadline passed while its pod was
// busy, and replicas sharing one durable while one of them goes away.
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connectNats, drain, publishResult, subscribe, type NatsSubscribeConfig, type SubscribeOptions, type TaskDelivery } from "../src/nats/index.ts";
import { createShutdown } from "../src/drain.ts";
import { lostTaskResult, type TaskResult } from "../src/contract/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 10_000, what = "condition") {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`waitFor timed out: ${what}`);
    await sleep(25);
  }
}
/** Block the event loop, as a long synchronous call (e.g. rmSync of a big tree) does. */
function blockEventLoop(ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy */ }
}

const NATS_BIN = process.env["NATS_SERVER_BIN"] ?? ["/usr/local/bin/nats-server", "/usr/bin/nats-server"].find(existsSync) ?? "nats-server";
function hasBin(bin: string): boolean {
  if (bin.includes("/")) return existsSync(bin);
  return (process.env["PATH"] ?? "").split(":").some((d) => existsSync(join(d, bin)));
}

const okResult = (taskId: string): TaskResult => ({
  task_id: taskId, knight: "K", success: true, result: "done", duration_ms: 1, cost: 0,
  tokens: { input: 0, output: 0 }, model: "m", timestamp: new Date().toISOString(),
});
const lostResult = (taskId: string): TaskResult => lostTaskResult({ taskId, knight: "K", model: "m" });

describe("tasks during a pod replacement (real nats-server) (#75)", { skip: !hasBin(NATS_BIN) && "nats-server not found (set NATS_SERVER_BIN)" }, () => {
  let proc: ChildProcess;
  let dir: string;
  let admin: NatsConnection;
  const advisories: number[] = [];
  let url = "";
  const cfg = (name: string): NatsSubscribeConfig => ({
    knightName: name,
    natsUrl: url,
    natsTasksStream: "TASKS",
    natsResultsPrefix: "fleet-a.results",
    subscribeTopics: [`fleet-a.tasks.${name.toLowerCase()}.>`],
  });

  before(async () => {
    // A free port from the OS (the other real-NATS test files pick random ports in fixed ranges).
    const port = await new Promise<number>((resolve) => {
      const srv = createServer().listen(0, "127.0.0.1", () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });
    url = `nats://127.0.0.1:${port}`;
    dir = mkdtempSync(join(tmpdir(), "nats-rollout-"));
    proc = spawn(NATS_BIN, ["-js", "-p", String(port), "-sd", dir], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try { admin = await connect({ servers: url }); break; } catch { await sleep(100); }
    }
    const jsm = await jetstreamManager(admin);
    await jsm.streams.add({ name: "TASKS", subjects: ["fleet-a.tasks.>", "fleet-a.results.>"] });
    const adv = admin.subscribe("$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.TASKS.>");
    void (async () => { for await (const m of adv) advisories.push(m.json<{ stream_seq: number }>().stream_seq); })();
    await admin.flush();
    await connectNats(cfg("Main"), "test-knight-rollout");
  });

  after(async () => {
    await drain().catch(() => {});
    await admin?.close().catch(() => {});
    proc?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  // The operator-owned consumer, as the operator creates it (ack_wait 1 s instead of 30 s).
  const preCreate = async (name: string) => {
    const jsm = await jetstreamManager(admin);
    await jsm.consumers.add("TASKS", {
      durable_name: `${name}-consumer`, filter_subjects: [`fleet-a.tasks.${name.toLowerCase()}.>`],
      ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.All, max_deliver: 1, ack_wait: 1_000_000_000,
    });
  };
  const publishTask = async (name: string, id: string) =>
    (await jetstream(admin).publish(`fleet-a.tasks.${name.toLowerCase()}.${id}`, JSON.stringify({ task: `do ${id}`, taskId: id }))).seq;

  /** Every result published for a task, oldest first. */
  const resultsFor = async (taskId: string): Promise<Array<{ success: boolean; lost?: boolean }>> => {
    const c = await jetstream(admin).consumers.get("TASKS", { filter_subjects: [`fleet-a.results.${taskId}`] });
    const out: Array<{ success: boolean; lost?: boolean }> = [];
    const it = await c.fetch({ max_messages: 100, expires: 1000 });
    for await (const m of it) {
      out.push(m.json());
      if (m.info.pending === 0) break;
    }
    return out;
  };
  const assertNoFailureAfterSuccess = (rs: Array<{ success: boolean }>) => {
    const firstOk = rs.findIndex((r) => r.success);
    assert.ok(firstOk === -1 || rs.slice(firstOk).every((r) => r.success), `a failing result after a successful one: ${JSON.stringify(rs)}`);
  };
  const ackPending = async (name: string) => (await (await jetstreamManager(admin)).consumers.info("TASKS", `${name}-consumer`)).num_ack_pending;

  /** A knight the way the runtimes wire it: slots, heartbeat while running, publish then ack. */
  function knight(name: string, run: (d: TaskDelivery) => Promise<void>, extra: Partial<SubscribeOptions> = {}) {
    const st = { active: 0, shuttingDown: false, ran: [] as string[], lost: [] as string[] };
    const opts: SubscribeOptions = {
      freeSlots: () => (st.shuttingDown ? 0 : 1 - st.active),
      onTask: (d) => {
        st.active++;
        st.ran.push(d.task.taskId);
        const hb = setInterval(() => d.working(), 300);
        void run(d)
          .then(() => publishResult(d.task.taskId, okResult(d.task.taskId)))
          .finally(() => { clearInterval(hb); d.ack(); st.active--; });
      },
      onLost: async (t) => { st.lost.push(t.taskId); await publishResult(t.taskId, lostResult(t.taskId)); },
      ...extra,
    };
    return { st, start: () => subscribe(cfg(name), opts) };
  }

  it("case 2: SIGTERM with a pull request outstanding, then a task arrives — it is run and answered, not lost", async () => {
    await preCreate("Sigterm");
    const k = knight("Sigterm", () => sleep(300));
    const puller = await k.start();
    await sleep(300); // the pull loop now has a pull request open on the server (expires after 5 s)

    let exited = false;
    const shutdown = createShutdown({
      setDraining: (d) => { k.st.shuttingDown = d; },
      stopPulling: () => puller.stop(),
      getActive: () => k.st.active,
      maxWaitMs: 10_000,
      pollMs: 20,
      drainNats: async () => {},
      exit: () => { exited = true; },
    });
    const done = shutdown("SIGTERM");
    await sleep(50);
    const seq = await publishTask("Sigterm", "late1"); // lands on the stopping pod's open pull request
    await done;
    assert.ok(exited);
    await sleep(2500); // well past ack_wait: an un-run, un-acked delivery would be dead-lettered by now

    assert.deepEqual(k.st.ran, ["late1"], "the task delivered during shutdown was run before exit");
    assert.ok(!advisories.includes(seq), "no MAX_DELIVERIES advisory: the task was not lost");
    assert.deepEqual((await resultsFor("late1")).map((r) => r.success), [true]);
    assert.equal(await ackPending("Sigterm"), 0);
  });

  it("case 1: the pod misses the ack deadline while still running the task — no lost result, the success is the answer", async () => {
    await preCreate("Blocked");
    const k = knight("Blocked", async () => {
      await sleep(200);
      blockEventLoop(3000); // heartbeats cannot fire: the server gives up on the message (ack_wait 1 s)
    });
    const puller = await k.start();
    const seq = await publishTask("Blocked", "slow1");
    await waitFor(() => advisories.includes(seq), 10_000, "MAX_DELIVERIES advisory");
    await waitFor(() => k.st.active === 0, 10_000, "task finished");
    await sleep(500);

    assert.deepEqual(k.st.lost, [], "the pod that is answering the task itself does not report it lost");
    const rs = await resultsFor("slow1");
    assert.deepEqual(rs.map((r) => r.success), [true]);
    assertNoFailureAfterSuccess(rs);
    await puller.stop();
  });

  it("two replicas on one durable: one shuts down while the other runs a task longer than ack_wait", async () => {
    await preCreate("Pair");
    const ncA = await connect({ servers: url });
    // Replica A is busy (no free slot), so the task goes to B; then A is replaced.
    const a = knight("Pair", () => sleep(10), { connection: ncA, freeSlots: () => 0 });
    const b = knight("Pair", () => sleep(2500));
    const pullerA = await a.start();
    const pullerB = await b.start();
    const seq = await publishTask("Pair", "long1");
    await waitFor(() => b.st.ran.length === 1, 10_000, "B took the task");

    await createShutdown({
      setDraining: (d) => { a.st.shuttingDown = d; },
      stopPulling: () => pullerA.stop(),
      getActive: () => a.st.active,
      maxWaitMs: 5_000,
      pollMs: 20,
      drainNats: () => ncA.drain(),
      exit: () => {},
    })("SIGTERM");

    await waitFor(() => b.st.active === 0, 10_000, "B finished");
    await sleep(1500);
    assert.ok(!advisories.includes(seq), "B's heartbeats kept the task alive while A went away");
    assert.deepEqual([...a.st.lost, ...b.st.lost], []);
    assert.deepEqual((await resultsFor("long1")).map((r) => r.success), [true]);
    await pullerB.stop();
  });

  it("a replica dies after publishing its success but before acking: the other replica does not report the task lost", async () => {
    await preCreate("Crash");
    const ncA = await connect({ servers: url });
    const a = knight("Crash", () => sleep(10), { connection: ncA, freeSlots: () => 0 });
    const pullerA = await a.start();
    // B publishes its successful result, then the pod is killed before the ack (SIGKILL at the end of the grace period).
    let deliveryB: TaskDelivery | undefined;
    const pullerB = await subscribe(cfg("Crash"), {
      freeSlots: () => (deliveryB ? 0 : 1),
      onTask: (d) => { deliveryB = d; },
      onLost: () => { throw new Error("B is dead"); },
    });
    const seq = await publishTask("Crash", "dead1");
    await waitFor(() => !!deliveryB, 10_000, "B took the task");
    await publishResult("dead1", okResult("dead1"));
    await pullerB.stop(); // B is gone: no heartbeat, no ack, no advisory subscription

    await waitFor(() => advisories.includes(seq), 10_000, "MAX_DELIVERIES advisory");
    await sleep(1000);
    assert.deepEqual(a.st.lost, [], "A found the successful result and did not report the task lost");
    const rs = await resultsFor("dead1");
    assert.deepEqual(rs.map((r) => r.success), [true]);
    assertNoFailureAfterSuccess(rs);
    await pullerA.stop();
    await ncA.close();
  });
});
