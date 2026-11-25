/**
 * Send one task to a knight over a local NATS server and print its result.
 *
 *   npm run dev:send -- "Say hello." [--knight dev] [--domain dev] [--timeout 120] [--url nats://127.0.0.1:4222]
 *
 * Publishes a TaskPayload (packages/core/contract/fixtures/task.minimal.json) on
 * `fleet-a.tasks.<domain>.<id>` (domain defaults to the knight name, lowercased, matching the
 * default SUBSCRIBE_TOPICS of nats-up.sh) and waits for the result on `fleet-a.results.<id>`.
 * Prints the result JSON. Exit code: 0 success, 1 failure result, 2 no result before --timeout.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { connect } from "@nats-io/transport-node";
import { jetstream } from "@nats-io/jetstream";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    knight: { type: "string", default: process.env.KNIGHT_NAME ?? "dev" },
    domain: { type: "string" },
    timeout: { type: "string", default: "120" },
    url: { type: "string", default: process.env.NATS_URL ?? "nats://127.0.0.1:4222" },
    prefix: { type: "string", default: "fleet-a" },
    id: { type: "string" },
  },
});

const task = positionals.join(" ").trim();
if (!task) {
  console.error('usage: send-task "<task text>" [--knight dev] [--domain <domain>] [--timeout <seconds>] [--url <nats url>]');
  process.exit(64);
}
const timeoutS = Number(values.timeout);
if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
  console.error(`send-task: --timeout must be a positive number of seconds, got "${values.timeout}"`);
  process.exit(64);
}
const domain = values.domain ?? values.knight.toLowerCase();
const taskId = values.id ?? `dev-${randomUUID().slice(0, 8)}`;

const nc = await connect({ servers: values.url, name: "knights-dev-send-task" });
let code = 2;
try {
  // Subscribe before publishing so a fast result is not missed.
  const sub = nc.subscribe(`${values.prefix}.results.${taskId}`, { max: 1, timeout: timeoutS * 1000 });
  const subject = `${values.prefix}.tasks.${domain}.${taskId}`;
  await jetstream(nc).publish(subject, JSON.stringify({ taskId, task, timestamp: new Date().toISOString() }));
  console.error(`send-task: published ${taskId} on ${subject}, waiting up to ${timeoutS}s for ${values.prefix}.results.${taskId}`);
  try {
    for await (const m of sub) {
      const result = m.json<{ success?: boolean }>();
      console.log(JSON.stringify(result, null, 2));
      code = result.success === true ? 0 : 1;
    }
  } catch {
    console.error(`send-task: no result for ${taskId} within ${timeoutS}s`);
  }
} finally {
  await nc.close();
}
process.exit(code);
