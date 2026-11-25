import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { AckPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";
import { connectNats, drain, publishResult, startPullLoop, subscribe, type NatsSubscribeConfig, type PulledMsg, type TaskDelivery } from "../src/nats/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await sleep(25);
  }
}

describe("pull loop (fake fetch)", () => {
  const msg = (id: string): PulledMsg => ({
    data: new TextEncoder().encode(JSON.stringify({ task: `do ${id}`, taskId: id })),
    subject: `fleet-a.tasks.x.${id}`,
    ack() {}, working() {}, term() {}, nak() {},
  });

  it("requests exactly the number of free slots and nothing when full", async () => {
    let free = 0;
    const requests: number[] = [];
    const got: string[] = [];
    const puller = startPullLoop({
      freeSlots: () => free,
      fetch: async (max) => {
        requests.push(max);
        return (async function* () { for (let i = 0; i < max; i++) yield msg(`t${requests.length}-${i}`); })();
      },
      onTask: (d) => { got.push(d.task.taskId); free--; },
    });
    await sleep(100);
    assert.deepEqual(requests, [], "no fetch while no slot is free");
    free = 2;
    puller.wake();
    await waitFor(() => got.length === 2);
    assert.deepEqual(requests, [2]);
    free = 1; // one slot freed
    puller.wake();
    await waitFor(() => got.length === 3);
    assert.equal(requests[1], 1);
    await puller.stop();
  });

  it("naks, without handling, messages delivered from an in-flight fetch after stop", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let fetching!: () => void;
    const inFetch = new Promise<void>((r) => { fetching = r; });
    const calls: string[] = [];
    const handled: string[] = [];
    const m: PulledMsg = { ...msg("late"), nak: () => calls.push("nak") };
    const puller = startPullLoop({
      freeSlots: () => 1,
      fetch: async () => (async function* () { fetching(); await gate; yield m; })(),
      onTask: (d) => { handled.push(d.task.taskId); },
    });
    await inFetch;
    const stopping = puller.stop();
    release();
    await stopping;
    assert.deepEqual(handled, []);
    assert.deepEqual(calls, ["nak"]);
  });

  it("terms empty payloads and acks filtered ones without running them", async () => {
    const calls: string[] = [];
    const mk = (body: string): PulledMsg => ({
      data: new TextEncoder().encode(body), subject: "fleet-a.tasks.x.1",
      ack: () => calls.push("ack"), working() {}, term: () => calls.push("term"), nak() {},
    });
    let served = false;
    const ran: string[] = [];
    const puller = startPullLoop({
      freeSlots: () => 5,
      fetch: async () => {
        const batch = served ? [] : [mk(JSON.stringify({ task: "  " })), mk(JSON.stringify({ task: "hi", from: "me" }))];
        served = true;
        if (batch.length === 0) await sleep(50);
        return (async function* () { yield* batch; })();
      },
      accept: (t) => t.from !== "me",
      onTask: (d) => ran.push(d.task.task),
    });
    await waitFor(() => calls.length === 2);
    assert.deepEqual(calls, ["term", "ack"]);
    assert.deepEqual(ran, []);
    await puller.stop();
  });

  it("answers a payload that breaks the schema through onInvalid, then acks it; terms it without onInvalid (#6)", async () => {
    const calls: string[] = [];
    const mk = (body: string): PulledMsg => ({
      data: new TextEncoder().encode(body), subject: "fleet-a.tasks.x.subj",
      ack: () => calls.push("ack"), working() {}, term: () => calls.push("term"), nak() {},
    });
    const run = async (onInvalid?: (t: TaskDelivery["task"]) => Promise<void>) => {
      let served = false;
      const ran: string[] = [];
      const puller = startPullLoop({
        freeSlots: () => 5,
        fetch: async () => {
          const batch = served ? [] : [mk(JSON.stringify({ taskId: "bad1", task: "x", runId: 42 }))];
          served = true;
          if (batch.length === 0) await sleep(50);
          return (async function* () { yield* batch; })();
        },
        onTask: (d) => ran.push(d.task.task),
        onInvalid,
      });
      await waitFor(() => calls.length > 0);
      await puller.stop();
      assert.deepEqual(ran, [], "an invalid task never runs");
    };
    const answered: string[] = [];
    await run(async (t) => { await sleep(20); answered.push(`${t.taskId}: ${t.invalid}`); calls.push("answered"); });
    await waitFor(() => calls.length === 2);
    assert.deepEqual(answered, ["bad1: runId: must be string"]);
    assert.deepEqual(calls, ["answered", "ack"], "acked only after the answer");
    calls.length = 0;
    await run();
    assert.deepEqual(calls, ["term"]);
  });
});

const NATS_BIN = process.env["NATS_SERVER_BIN"] ?? ["/usr/local/bin/nats-server", "/usr/bin/nats-server"].find(existsSync) ?? "nats-server";

describe("pull consumer against a real nats-server", { skip: !hasBin(NATS_BIN) && "nats-server not found (set NATS_SERVER_BIN)" }, () => {
  let proc: ChildProcess;
  let dir: string;
  let admin: NatsConnection;
  const port = 4300 + Math.floor(Math.random() * 500);
  const config: NatsSubscribeConfig = {
    knightName: "Tester",
    natsUrl: `nats://127.0.0.1:${port}`,
    natsTasksStream: "TASKS",
    natsResultsPrefix: "fleet-a.results",
    subscribeTopics: ["fleet-a.tasks.tester.>"],
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "nats-"));
    proc = spawn(NATS_BIN, ["-js", "-p", String(port), "-sd", dir], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      try { admin = await connect({ servers: config.natsUrl }); break; } catch { await sleep(100); }
    }
    const jsm = await jetstreamManager(admin);
    await jsm.streams.add({ name: "TASKS", subjects: ["fleet-a.tasks.>", "fleet-a.results.>"] });
    await connectNats(config, "test-knight-Tester");
  });

  after(async () => {
    await drain().catch(() => {});
    await admin?.close().catch(() => {});
    proc?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  const publishTask = (id: string, topic = "tester") =>
    jetstream(admin).publish(`fleet-a.tasks.${topic}.${id}`, new TextEncoder().encode(JSON.stringify({ task: `do ${id}`, taskId: id })));

  it("holds backlog in the stream (lag), takes the next task when a slot frees, and recovers a crashed task", async () => {
    for (const id of ["a", "b", "c", "d"]) await publishTask(id);

    let active = 0;
    const deliveries: TaskDelivery[] = [];
    const lost: string[] = [];
    const puller = await subscribe(config, {
      ackWaitMs: 1000,
      freeSlots: () => 1 - active,
      onTask: (d) => { active++; deliveries.push(d); },
      onLost: async (t) => {
        lost.push(t.taskId);
        await publishResult(t.taskId, {
          task_id: t.taskId, knight: "Tester", success: false, result: "lost", error: "lost", lost: true,
          duration_ms: 0, cost: 0, tokens: { input: 0, output: 0 }, model: "m", timestamp: new Date().toISOString(),
        });
      },
    });

    await waitFor(() => deliveries.length === 1);
    await sleep(300);
    assert.equal(deliveries.length, 1, "only one slot, so only one task taken");
    const jsm = await jetstreamManager(admin);
    const info = await jsm.consumers.info("TASKS", "Tester-consumer");
    assert.equal(info.num_pending, 3, "lag reflects the backlog still in the stream");
    assert.equal(info.num_ack_pending, 1);
    assert.equal(info.config.max_deliver, 1);

    // heartbeats keep the task alive well past ack_wait (1s)
    const hb = setInterval(() => deliveries[0]!.working(), 300);
    await sleep(2500);
    clearInterval(hb);
    assert.deepEqual(lost, [], "in-progress acks prevent the task being declared lost");

    // finish -> slot frees -> next task is fetched
    deliveries[0]!.ack();
    active--;
    puller.wake();
    await waitFor(() => deliveries.length === 2);
    assert.equal(deliveries[1]!.task.taskId, "b");

    // "crash": task b is never acked and never heartbeats -> reported, not silently lost or re-run
    await waitFor(() => lost.length === 1, 10_000);
    assert.deepEqual(lost, ["b"]);
    const results = await jetstream(admin).consumers.get("TASKS", await (async () => {
      const ci = await jsm.consumers.add("TASKS", { filter_subject: "fleet-a.results.b", ack_policy: AckPolicy.None });
      return ci.name;
    })());
    const m = await results.next({ expires: 2000 });
    assert.equal(JSON.parse(new TextDecoder().decode(m!.data)).error, "lost");
    assert.equal(deliveries.filter((d) => d.task.taskId === "b").length, 1, "never redelivered");
    await puller.stop();
  });

  it("sends in-progress heartbeats for a running task and acks it exactly once (#8)", async () => {
    const beater: NatsSubscribeConfig = { ...config, knightName: "Beater", subscribeTopics: ["fleet-a.tasks.beater.>"] };
    // Watch the consumer's ack subject on the wire: +WPI is working(), +ACK the final ack.
    const acks: string[] = [];
    const ackSub = admin.subscribe("$JS.ACK.TASKS.Beater-consumer.>");
    void (async () => { for await (const m of ackSub) acks.push(m.string()); })();
    await admin.flush();

    let active = 0;
    const lost: string[] = [];
    const done: string[] = [];
    const puller = await subscribe(beater, {
      ackWaitMs: 1000,
      freeSlots: () => 1 - active,
      onLost: (t) => { lost.push(t.taskId); },
      // What the runtimes do: heartbeat while the task runs, then ack once it finished.
      onTask: (d) => {
        active++;
        const hb = setInterval(() => d.working(), 300);
        setTimeout(() => {
          clearInterval(hb);
          d.ack();
          done.push(d.task.taskId);
          active--;
        }, 2500);
      },
    });
    await publishTask("hb1", "beater");
    await waitFor(() => done.length === 1, 10_000);
    await sleep(1500); // past ack_wait: a missed heartbeat or ack would surface as a lost task by now

    const info = await (await jetstreamManager(admin)).consumers.info("TASKS", "Beater-consumer");
    assert.deepEqual(lost, [], "heartbeats kept the task alive past ack_wait");
    assert.equal(info.num_ack_pending, 0);
    assert.equal(info.num_redelivered, 0);
    assert.equal(info.ack_floor.consumer_seq, 1, "the task is acked");
    assert.ok(acks.filter((a) => a === "+WPI").length >= 5, `heartbeats sent while running: ${JSON.stringify(acks)}`);
    assert.equal(acks.filter((a) => a !== "+WPI").length, 1, `exactly one final ack: ${JSON.stringify(acks)}`);
    assert.equal(acks.at(-1), "+ACK");
    ackSub.unsubscribe();
    await puller.stop();
  });
});

function hasBin(bin: string): boolean {
  if (bin.includes("/")) return existsSync(bin);
  return (process.env["PATH"] ?? "").split(":").some((d) => existsSync(join(d, bin)));
}
