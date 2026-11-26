/**
 * Claude Code's built-in OpenTelemetry export, switched on for the child.
 *
 * When the pod has an OTLP endpoint, the Claude Code CLI exports its own spans
 * (claude_code.interaction, llm_request, tool) and metrics and log events. The
 * child inherits TRACEPARENT from the knight.task span (see buildChildEnv), so
 * its interaction span becomes a child of the task. Content (prompts, responses,
 * tool input/output) is on by default; the chart collector's redaction processor
 * is the redaction step for these spans, since the export runs inside the CLI.
 *
 * Every switch is added only when the pod env does not already set that key,
 * so an explicit pod value always wins. With no OTLP endpoint, nothing is added.
 */

import { telemetryEnabled } from "@roundtable/knight-core";

type Env = NodeJS.ProcessEnv;

function present(env: Env, name: string): boolean {
  return (env[name] ?? "").trim().length > 0;
}

/**
 * Environment for the Claude Code child that turns on its built-in OTel export.
 * Returns {} when no OTLP endpoint is configured.
 */
export function claudeCodeTelemetryEnv(env: Env = process.env): Record<string, string> {
  if (!telemetryEnabled(env)) return {};
  const out: Record<string, string> = {};
  const set = (name: string, value: string) => {
    if (!present(env, name)) out[name] = value;
  };

  // Traces are beta and need the enhanced switch; metrics and log events use their own exporters.
  set("CLAUDE_CODE_ENABLE_TELEMETRY", "1");
  set("CLAUDE_CODE_ENHANCED_TELEMETRY_BETA", "1");
  set("OTEL_TRACES_EXPORTER", "otlp");
  // Metrics and logs have no traces-endpoint fallback: without a general or per-signal
  // endpoint they would go to the default localhost:4318, so leave them off.
  if (present(env, "OTEL_EXPORTER_OTLP_ENDPOINT") || present(env, "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT")) {
    set("OTEL_METRICS_EXPORTER", "otlp");
  }
  if (present(env, "OTEL_EXPORTER_OTLP_ENDPOINT") || present(env, "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT")) {
    set("OTEL_LOGS_EXPORTER", "otlp");
  }
  // Group the child's spans with ours.
  set("OTEL_SERVICE_NAME", "claude-knight");

  // Content is captured by default; ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT=false turns it off.
  // OTEL_LOG_RAW_API_BODIES is never set: it would dump whole request and response bodies.
  const capture = (env["ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT"] ?? "").trim().toLowerCase() !== "false";
  const flag = capture ? "1" : "0";
  set("OTEL_LOG_USER_PROMPTS", flag);
  set("OTEL_LOG_ASSISTANT_RESPONSES", flag);
  set("OTEL_LOG_TOOL_DETAILS", flag);
  set("OTEL_LOG_TOOL_CONTENT", flag);
  return out;
}
