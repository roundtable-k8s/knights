// Loaded with `node --import` before every test file (see each package's
// "test" script). Knight pods carry operator-set variables (ROUNDTABLE_TABLE,
// KNIGHT_NAME, NATS_URL, ...); tests must not depend on them, so drop every
// variable the runtimes read before the test file runs. Tests that need a value
// set it themselves, and process-level tests pass an explicit env to the child.
const PREFIXES = ["ROUNDTABLE_", "KNIGHT_", "NATS_", "OTEL_", "CLAUDE_", "BROWSER_", "MODEL_"];
const KEEP = new Set(["NATS_SERVER_BIN"]); // test tooling, not runtime config
const NAMES = [
  "POD_NAME",
  "NODE_NAME",
  "LOG_LEVEL",
  "DEBUG",
  "ACTIVITY_CONTENT",
  "MODELS_JSON_PATH",
  "MCP_SERVERS_JSON",
  "MAX_CONCURRENT_TASKS",
  "METRICS_PORT", // operator-injected: a spawned runtime would bind :3000
  "SUBSCRIBE_TOPICS",
  "TASK_TIMEOUT_MS",
  "POD_NAMESPACE",
  "ABORTED_TASK_IS_FAILURE",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "AGENT_BROWSER_BIN",
];

for (const key of Object.keys(process.env)) {
  if (KEEP.has(key)) continue;
  if (NAMES.includes(key) || PREFIXES.some((p) => key.startsWith(p))) delete process.env[key];
}
