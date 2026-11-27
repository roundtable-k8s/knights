/**
 * Claude Code's own OpenTelemetry export, end to end with the REAL Claude Code
 * binary against the scripted mock Messages API (no credential, localhost
 * only). One task runs through executeTask inside withTaskSpan, with
 * OTEL_EXPORTER_OTLP_ENDPOINT pointing at a local receiver. The test checks
 * that the CLI's claude_code.interaction span is a child of the knight's task
 * span (via TRACEPARENT) and that the prompt content is in the export, and
 * absent with ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT=false.
 *
 * Observed with the pinned CLI (2.1.329): it honours OTEL_EXPORTER_OTLP_PROTOCOL=http/json
 * and the *_EXPORT_INTERVAL variables, exports claude_code.interaction with
 * parent = the TRACEPARENT span, and puts the prompt on that span and on the
 * user_prompt log event. The CLI exits after -p without waiting, so the test waits
 * for the export rather than for the process.
 *
 * Skipped when the binary is missing or CK_SKIP_CLI_E2E=1.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { startTelemetry, withTaskSpan, type Telemetry } from "@roundtable/knight-core";
import { loadConfig, type KnightConfig } from "../src/config.js";
import { executeTask, resetKnightState, type ExecuteOverrides } from "../src/knight.js";
import { startMockAnthropic, type MockAnthropic } from "./helpers/mock-anthropic.js";
import { startOtlpReceiver, type OtlpReceiver } from "./helpers/otlp-receiver.js";

function bundledClaude(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const bin = join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json")), "claude");
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

const BIN = process.env.CK_CLAUDE_BIN || bundledClaude();
const skip = process.env.CK_SKIP_CLI_E2E === "1" ? "CK_SKIP_CLI_E2E=1" : !BIN ? "Claude Code binary not installed" : false;

let mock: MockAnthropic;
let receiver: OtlpReceiver;
let config: KnightConfig;
let home: string;
let over: ExecuteOverrides;
let telemetry: Telemetry;
const spanExporter = new InMemorySpanExporter();
const savedEnv: Record<string, string | undefined> = {};

// buildChildEnv reads process.env, so the OTLP settings go there for the run and are restored after.
// http/json is what the receiver decodes; the short intervals make the CLI flush promptly.
function setProcessEnv(extra: Record<string, string>) {
  const vars: Record<string, string> = {
    OTEL_EXPORTER_OTLP_ENDPOINT: receiver.url,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/json",
    OTEL_TRACES_EXPORT_INTERVAL: "500",
    OTEL_LOGS_EXPORT_INTERVAL: "500",
    OTEL_METRIC_EXPORT_INTERVAL: "1000",
    ...extra,
  };
  for (const k of [...Object.keys(vars), "ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT"]) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
}

before(async () => {
  if (skip) return;
  mock = await startMockAnthropic();
  receiver = await startOtlpReceiver();
  home = mkdtempSync(join(tmpdir(), "ck-otel-e2e-"));
  const work = join(home, "data");
  mkdirSync(join(work, ".claude-home"), { recursive: true });
  writeFileSync(join(work, ".claude-home", ".claude.json"), '{"hasCompletedOnboarding":true}');
  config = loadConfig({
    KNIGHT_NAME: "Gawain",
    SUBSCRIBE_TOPICS: "rt.tasks.security.>",
    KNIGHT_MODEL: "sonnet",
    KNIGHT_WORKDIR: work,
    KNIGHT_SKILLS_DIR: join(home, "skills"),
    KNIGHT_CONFIG_DIR: join(home, "config"),
    CLAUDE_AUTH_MODE: "api",
    CLAUDE_RUNTIME: "cli",
    CLAUDE_BIN: BIN!,
  });
  setProcessEnv({});
  // The knight's own spans go to memory; the receiver only sees what the CLI exports.
  telemetry = await startTelemetry({
    service: "claude-knight",
    knight: "Gawain",
    env: { OTEL_TRACES_EXPORTER: "otlp" },
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  // A clean environment (nothing from the developer's own Claude Code setup), plus the
  // telemetry and trace-context variables the knight adds for the child.
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    ANTHROPIC_API_KEY: "sk-ant-api03-fake-e2e",
    ANTHROPIC_BASE_URL: mock.url,
  };
  over = {
    cliInvocation: (inv) => ({
      ...inv,
      env: {
        ...env,
        ...Object.fromEntries(
          Object.entries(inv.env).filter(
            ([k, v]) => v != null && /^(OTEL_|CLAUDE_CODE_|CLAUDE_CONFIG_DIR$|DISABLE_AUTOUPDATER$|TRACEPARENT$|TRACESTATE$)/.test(k),
          ),
        ),
      },
    }),
  };
  resetKnightState();
});

after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await telemetry?.shutdown();
  await receiver?.close();
  await mock?.close();
});

async function runTraced(prompt: string) {
  const taskId = `otel-${Date.now()}`;
  const result = await withTaskSpan(
    { taskId, knight: "Gawain", runtime: "claude" },
    () => executeTask(prompt, taskId, config, new AbortController().signal, undefined, over),
  );
  assert.equal(result.success, true, result.error);
  const findTask = () => spanExporter.getFinishedSpans().find((s) => s.attributes["roundtable.task.id"] === taskId);
  // SimpleSpanProcessor may hand the span over a tick after it ends.
  await receiver.waitFor(() => !!findTask(), 5_000);
  const task = findTask();
  assert.ok(task, "the knight's task span was recorded");
  const { traceId, spanId } = task.spanContext();
  const interaction = () => receiver.spans.find((s) => s.name === "claude_code.interaction" && s.traceId === traceId);
  const arrived = await receiver.waitFor(() => !!interaction(), 30_000);
  const seen = receiver.spans.map((s) => `${s.name}(trace ${s.traceId.slice(0, 8)}, parent ${s.parentSpanId.slice(0, 8)})`).join(", ");
  assert.ok(arrived, `claude_code.interaction exported on the task's trace; receiver got spans [${seen}], rejected ${JSON.stringify(receiver.rejected)}`);
  // Give the log and tool exports a moment after the interaction span.
  await new Promise((r) => setTimeout(r, 1500));
  return { traceId, spanId, interaction: interaction()! };
}

const exportText = () => JSON.stringify({ spans: receiver.spans, logs: receiver.logs });

test("Claude Code's interaction span is a child of knight.task and carries the prompt", { skip, timeout: 120_000 }, async () => {
  const marker = "PLANTED-PROMPT-MARKER-7f3a";
  const { traceId, spanId, interaction } = await runTraced(`say pong ${marker}`);
  assert.equal(interaction.traceId, traceId);
  assert.equal(interaction.parentSpanId, spanId, "claude_code.interaction is parented to the knight's task span");
  assert.ok(exportText().includes(marker), "the prompt text is in the exported spans or log events");
});

test("ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT=false keeps the prompt out of the export", { skip, timeout: 120_000 }, async () => {
  receiver.spans.length = 0;
  receiver.logs.length = 0;
  setProcessEnv({ ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT: "false" });
  const marker = "SECRET-PROMPT-MARKER-91bc";
  const { interaction, spanId } = await runTraced(`say pong ${marker}`);
  assert.equal(interaction.parentSpanId, spanId);
  assert.ok(!exportText().includes(marker), "the prompt text is not in the export");
});
