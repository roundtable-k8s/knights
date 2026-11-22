/**
 * Optional live test: one real task through `claude -p` on a real Claude plan
 * token, the way a subscription knight runs it. Skipped unless
 * CK_LIVE_CLAUDE=1 (never in CI). Needs CLAUDE_CODE_OAUTH_TOKEN (from
 * `claude setup-token`) or the egress-injection env; uses the bundled CLI
 * unless CK_CLAUDE_BIN is set. Costs a little plan usage.
 *
 *   CK_LIVE_CLAUDE=1 CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-… npx tsx --test tests/claude-live.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { executeTask, getRecentTasks } from "../src/knight.js";
import { snapshot } from "../src/plan-limits.js";

function bundledClaude(): string | undefined {
  try {
    const bin = join(dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json")), "claude");
    return existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
}

const enabled = process.env.CK_LIVE_CLAUDE === "1";
const auth = checkAuth("subscription");
const skip = !enabled ? "set CK_LIVE_CLAUDE=1 to run" : !auth.ok ? `no subscription credential: ${auth.reason}` : false;

test("live: a subscription task runs through the real claude -p and resumes within a run", { skip, timeout: 300_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-live-"));
  const work = join(root, "data");
  mkdirSync(join(work, ".claude-home"), { recursive: true });
  writeFileSync(join(work, ".claude-home", ".claude.json"), '{"hasCompletedOnboarding":true}');
  const config = loadConfig({
    ...process.env,
    KNIGHT_NAME: "LiveTest",
    SUBSCRIBE_TOPICS: "test.tasks.>",
    KNIGHT_MODEL: process.env.CK_LIVE_MODEL ?? "haiku",
    KNIGHT_WORKDIR: work,
    KNIGHT_SKILLS_DIR: join(root, "skills"),
    KNIGHT_CONFIG_DIR: join(root, "config"),
    CLAUDE_CONFIG_DIR: join(work, ".claude-home"),
    CLAUDE_AUTH_MODE: "subscription",
    CLAUDE_RUNTIME: "cli",
    CLAUDE_BIN: process.env.CK_CLAUDE_BIN || bundledClaude() || "claude",
    CLAUDE_MAX_TURNS: "3",
  });
  const sig = new AbortController().signal;
  const a = await executeTask("Remember the word 'tangerine'. Reply with exactly: pong", "live-1", config, sig, "live-run");
  assert.equal(a.success, true, a.error);
  assert.match(a.result, /pong/i);
  assert.equal(a.billing, "subscription");
  const b = await executeTask("What word did I ask you to remember? Reply with just the word.", "live-2", config, sig, "live-run");
  assert.equal(b.success, true, b.error);
  assert.match(b.result, /tangerine/i);
  const [t1, t2] = getRecentTasks().slice(-2);
  assert.equal(t1!.sessionId, t2!.sessionId, "second step resumed the first step's session");
  // Plan windows, when the CLI reports them, reached the reserve tracker.
  console.log("plan windows:", JSON.stringify(snapshot()));
});
