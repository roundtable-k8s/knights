import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseModelStr, splitRoutingSuffix, resolveModel, createTrustedSettingsManager, isClaudeAlias, MissingCredentialsError } from "../src/model.ts";

test("parseModelStr splits provider from model, defaulting to anthropic", () => {
  assert.deepEqual(parseModelStr("openrouter/deepseek/deepseek-v3.2"), {
    provider: "openrouter",
    modelName: "deepseek/deepseek-v3.2",
  });
  assert.deepEqual(parseModelStr("claude-opus-4-8"), {
    provider: "anthropic",
    modelName: "claude-opus-4-8",
  });
});

test("splitRoutingSuffix strips known OpenRouter routing variants", () => {
  for (const suffix of ["floor", "nitro", "free", "online", "exacto"]) {
    assert.deepEqual(splitRoutingSuffix(`deepseek/deepseek-v3.2:${suffix}`), {
      base: "deepseek/deepseek-v3.2",
      suffix,
    });
  }
});

test("splitRoutingSuffix leaves plain slugs untouched", () => {
  assert.deepEqual(splitRoutingSuffix("deepseek/deepseek-v3.2"), { base: "deepseek/deepseek-v3.2" });
});

test("splitRoutingSuffix does not treat thinking levels as routing suffixes", () => {
  // ":high" is a thinking level handled downstream by the SDK, not a routing variant.
  assert.deepEqual(splitRoutingSuffix("claude-opus-4-8:high"), { base: "claude-opus-4-8:high" });
});

test("splitRoutingSuffix leaves unknown suffixes intact", () => {
  assert.deepEqual(splitRoutingSuffix("some/model:bogus"), { base: "some/model:bogus" });
});

test("resolveModel defaults the ollama provider to the local Ollama OpenAI endpoint", async () => {
  const prevBase = process.env.OPENAI_BASE_URL;
  const prevApiBase = process.env.OPENAI_API_BASE;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_API_BASE;
  try {
    const { model, provider, modelName } = await resolveModel("ollama/llama3.1");
    assert.equal(provider, "ollama");
    assert.equal(modelName, "llama3.1");
    assert.equal(model.baseUrl, "http://localhost:11434/v1");
  } finally {
    if (prevBase !== undefined) process.env.OPENAI_BASE_URL = prevBase;
    if (prevApiBase !== undefined) process.env.OPENAI_API_BASE = prevApiBase;
  }
});

test("createTrustedSettingsManager returns a project-trusted manager ", () => {
  const sm = createTrustedSettingsManager(process.cwd(), process.cwd());
  assert.equal(sm.isProjectTrusted(), true);
});

test("resolveModel makes the fallback model's reasoning flag env-overridable", async () => {
  const prev = process.env.MODEL_REASONING;
  try {
    delete process.env.MODEL_REASONING;
    assert.equal((await resolveModel("ollama/gpt-oss:20b")).model.reasoning, false, "defaults off");

    process.env.MODEL_REASONING = "true";
    assert.equal((await resolveModel("ollama/gpt-oss:20b")).model.reasoning, true, "opt-in for reasoning models");
  } finally {
    if (prev !== undefined) process.env.MODEL_REASONING = prev;
    else delete process.env.MODEL_REASONING;
  }
});

test("resolveModel honors an explicit OPENAI_BASE_URL over the ollama default", async () => {
  const prevBase = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "http://ollama.ai.svc.cluster.local:11434/v1";
  try {
    const { model } = await resolveModel("ollama/llama3.1");
    assert.equal(model.baseUrl, "http://ollama.ai.svc.cluster.local:11434/v1");
  } finally {
    if (prevBase !== undefined) process.env.OPENAI_BASE_URL = prevBase;
    else delete process.env.OPENAI_BASE_URL;
  }
});

const ALIAS_ENV = ["KNIGHT_MODEL_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE", "MODELS_JSON_PATH"] as const;

/** Run fn with the given env vars set (undefined = unset), restoring the originals afterwards. */
async function withEnv(vars: Partial<Record<(typeof ALIAS_ENV)[number], string | undefined>>, fn: () => Promise<void>) {
  const prev = Object.fromEntries(ALIAS_ENV.map((k) => [k, process.env[k]]));
  for (const k of ALIAS_ENV) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try {
    await fn();
  } finally {
    for (const k of ALIAS_ENV) {
      if (prev[k] !== undefined) process.env[k] = prev[k];
      else delete process.env[k];
    }
  }
}

test("isClaudeAlias recognises claude-knight aliases and claude ids without a provider", () => {
  for (const name of ["sonnet", "opus", "haiku", "fable", "opusplan", "sonnet[1m]", "claude-sonnet-4-5"]) {
    assert.equal(isClaudeAlias(name), true, name);
  }
  for (const name of ["anthropic/claude-sonnet-4-5", "sonnet/x", "deepseek-v3", "my-sonnet", "sonnet:high"]) {
    assert.equal(isClaudeAlias(name), false, name);
  }
});

test("isClaudeAlias applies the routing suffix first", () => {
  assert.equal(isClaudeAlias("sonnet:floor"), true);
  assert.equal(isClaudeAlias("sonnet[1m]:nitro"), true);
  assert.equal(isClaudeAlias("claude-sonnet-4-5:floor"), true);
  assert.equal(isClaudeAlias("my-sonnet:floor"), false);
});

test("resolveModel words a typo'd claude-* id as a catalog miss, not a Claude Code alias", async () => {
  await withEnv({}, async () => {
    await assert.rejects(resolveModel("claude-sonet-9"), (e: Error) => /not in the model catalog/.test(e.message) && !/Claude Code alias/.test(e.message));
    await assert.rejects(resolveModel("sonnet:floor"), /is a Claude Code alias/);
  });
});

test("resolveModel rejects a bare Claude alias without a local endpoint instead of falling back to localhost", async () => {
  await withEnv({}, async () => {
    await assert.rejects(resolveModel("sonnet"), /is a Claude Code alias; pi-knight needs provider\/model, e.g. "anthropic\/claude-sonnet-4-5"/);
    await assert.rejects(resolveModel("sonnet", { strict: true }), /is a Claude Code alias/);
    await assert.rejects(resolveModel("opusplan"), /is a Claude Code alias/);
  });
});

test("resolveModel names the provider/model form for an unknown strict model", async () => {
  await withEnv({}, async () => {
    await assert.rejects(resolveModel("ollama/not-a-real-model", { strict: true }), /use provider\/model/);
  });
});

test("resolveModel still resolves a Claude alias when a local base URL is configured", async () => {
  await withEnv({ KNIGHT_MODEL_BASE_URL: "http://litellm.ai.svc.cluster.local:4000/v1" }, async () => {
    const { model } = await resolveModel("sonnet");
    assert.equal(model.baseUrl, "http://litellm.ai.svc.cluster.local:4000/v1");
    assert.equal(model.id, "sonnet");
  });
});

test("resolveModel leaves catalog provider/model ids unaffected", async () => {
  await withEnv({}, () =>
    withOneEnv("ANTHROPIC_API_KEY", "test-key", async () => {
      const { model, provider, modelName } = await resolveModel("anthropic/claude-sonnet-4-5");
      assert.equal(provider, "anthropic");
      assert.equal(modelName, "claude-sonnet-4-5");
      assert.equal(model.id, "claude-sonnet-4-5");
    }),
  );
});

/** Run fn with one env var set (undefined = unset), restoring the original afterwards. */
async function withOneEnv(name: string, value: string | undefined, fn: () => Promise<void>) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await fn();
  } finally {
    if (prev !== undefined) process.env[name] = prev;
    else delete process.env[name];
  }
}

test("resolveModel refuses a hosted catalog model without credentials, naming the provider", async () => {
  await withOneEnv("OPENROUTER_API_KEY", undefined, async () => {
    await assert.rejects(resolveModel("openrouter/deepseek/deepseek-v3.2"), (e: Error) => {
      assert.ok(e instanceof MissingCredentialsError, "typed error");
      assert.equal(e.name, "MissingCredentialsError");
      assert.match(e.message, /No credentials for provider "openrouter" \(model deepseek\/deepseek-v3\.2\)/);
      return true;
    });
  });
});

test("resolveModel resolves a hosted catalog model once its key is set", async () => {
  await withOneEnv("OPENROUTER_API_KEY", "test-key", async () => {
    const { model, provider } = await resolveModel("openrouter/deepseek/deepseek-v3.2");
    assert.equal(provider, "openrouter");
    assert.match(model.baseUrl, /^https:\/\//);
  });
});

test("resolveModel keeps the dummy key for a local models.json endpoint without credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-local-"));
  const modelsPath = join(dir, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        litellm: {
          baseUrl: "http://localhost:4000/v1",
          api: "openai-completions",
          models: [{ id: "local-model", name: "local-model", contextWindow: 8192, maxTokens: 1024 }],
        },
      },
    }),
  );
  try {
    await withEnv({ MODELS_JSON_PATH: modelsPath }, async () => {
      const { model, modelRuntime } = await resolveModel("litellm/local-model");
      assert.equal(model.baseUrl, "http://localhost:4000/v1");
      assert.equal(modelRuntime.hasConfiguredAuth("litellm"), true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveModel accepts a models.json entry named like an alias", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-alias-"));
  const modelsPath = join(dir, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        anthropic: {
          baseUrl: "http://models.example.internal/v1",
          api: "openai-completions",
          apiKey: "test",
          models: [{ id: "sonnet", name: "sonnet", contextWindow: 8192, maxTokens: 1024 }],
        },
      },
    }),
  );
  try {
    await withEnv({ MODELS_JSON_PATH: modelsPath }, async () => {
      const { model } = await resolveModel("sonnet");
      assert.equal(model.baseUrl, "http://models.example.internal/v1");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
