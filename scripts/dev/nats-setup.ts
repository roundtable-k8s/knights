/**
 * Create the JetStream streams and the durable pull consumer a knight expects, on a local
 * nats-server (see nats-up.sh). Idempotent: existing streams and consumers are updated.
 *
 *   tsx scripts/dev/nats-setup.ts [--url nats://127.0.0.1:4222] [--knight dev] [--topics fleet-a.tasks.dev.>]
 *
 * Arguments only (no env), so a shell that already has a knight's env cannot redirect it. Defaults
 * match what the knights read when NATS_TASKS_STREAM / NATS_RESULTS_STREAM / NATS_RESULTS_PREFIX
 * are unset, and the consumer matches what `subscribe` would create.
 */
import { parseArgs } from "node:util";
import { connect } from "@nats-io/transport-node";
import { AckPolicy, DeliverPolicy, JetStreamApiCodes, JetStreamApiError, jetstreamManager, StorageType, type JetStreamManager } from "@nats-io/jetstream";

interface SetupOptions {
  url: string;
  knight: string;
  /** Consumer filter subjects (the knight's SUBSCRIBE_TOPICS). */
  topics: string[];
  tasksStream: string;
  resultsStream: string;
  /** Subject prefix, e.g. "fleet-a": streams cover `<prefix>.tasks.>` and `<prefix>.results.>`. */
  prefix: string;
}

const notFound = (err: unknown, code: number) => err instanceof JetStreamApiError && err.code === code;

async function ensureStream(jsm: JetStreamManager, name: string, subjects: string[]): Promise<void> {
  try {
    const info = await jsm.streams.info(name);
    await jsm.streams.update(name, { ...info.config, subjects });
  } catch (err) {
    if (!notFound(err, JetStreamApiCodes.StreamNotFound)) throw err;
    await jsm.streams.add({ name, subjects, storage: StorageType.File });
  }
}

async function setup(o: SetupOptions): Promise<void> {
  const nc = await connect({ servers: o.url, name: "knights-dev-setup" });
  try {
    const jsm = await jetstreamManager(nc);
    await ensureStream(jsm, o.tasksStream, [`${o.prefix}.tasks.>`]);
    await ensureStream(jsm, o.resultsStream, [`${o.prefix}.results.>`]);
    const durable = `${o.knight}-consumer`;
    // Same settings as subscribe() in packages/core/src/nats/index.ts.
    const config = {
      durable_name: durable,
      filter_subjects: o.topics,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
      max_deliver: 1,
      ack_wait: 30_000 * 1_000_000, // 30 s in nanoseconds
    };
    try {
      await jsm.consumers.info(o.tasksStream, durable);
      await jsm.consumers.update(o.tasksStream, durable, { filter_subjects: o.topics });
    } catch (err) {
      if (!notFound(err, JetStreamApiCodes.ConsumerNotFound)) throw err;
      await jsm.consumers.add(o.tasksStream, config);
    }
    console.log(`streams ${o.tasksStream} (${o.prefix}.tasks.>), ${o.resultsStream} (${o.prefix}.results.>); consumer ${durable} on ${o.topics.join(",")}`);
  } finally {
    await nc.close();
  }
}

function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: "string", default: "nats://127.0.0.1:4222" },
      knight: { type: "string", default: "dev" },
      topics: { type: "string" },
      "tasks-stream": { type: "string", default: "fleet_a_tasks" },
      "results-stream": { type: "string", default: "fleet_a_results" },
      prefix: { type: "string", default: "fleet-a" },
    },
  });
  const topics = values.topics ?? `${values.prefix}.tasks.${values.knight.toLowerCase()}.>`;
  return setup({
    url: values.url,
    knight: values.knight,
    topics: topics.split(",").map((s) => s.trim()).filter(Boolean),
    tasksStream: values["tasks-stream"],
    resultsStream: values["results-stream"],
    prefix: values.prefix,
  });
}

main().catch((err) => {
  console.error(`nats-setup: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
