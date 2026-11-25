import { test } from "node:test";
import assert from "node:assert/strict";
import { agentShellEnv, scrubAgentEnv } from "../src/agent-env.js";

test("agentShellEnv drops NODE_ENV=production and npm omit switches", () => {
  const env = { NODE_ENV: "production", npm_config_omit: "dev", NPM_CONFIG_PRODUCTION: "true", PATH: "/bin" };
  assert.deepEqual(agentShellEnv(env), { PATH: "/bin" });
  assert.equal(env.NODE_ENV, "production", "input is not mutated");
});

test("agentShellEnv keeps other NODE_ENV values", () => {
  assert.equal(agentShellEnv({ NODE_ENV: "test" }).NODE_ENV, "test");
});

test("scrubAgentEnv removes the switches in place", () => {
  const env: Record<string, string | undefined> = { NODE_ENV: "production", npm_config_omit: "dev", HOME: "/h" };
  scrubAgentEnv(env);
  assert.deepEqual(env, { HOME: "/h" });
});
