import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

const script = resolve(import.meta.dirname, "..", "scripts", "seed-data.sh");

function run(env: Record<string, string>, call: string) {
  const r = spawnSync("bash", ["-c", `log() { echo "$*"; }\n. "${script}"\n${call}`], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r.stdout;
}

describe("entrypoint seeding (seed-data.sh)", () => {
  it("seeds defaults, syncs ConfigMap files and writes models.json under the data dir only", () => {
    const root = mkdtempSync(join(tmpdir(), "seed-"));
    try {
      const data = join(root, "data");
      const defaults = join(root, "defaults");
      const config = join(root, "config");
      mkdirSync(defaults);
      mkdirSync(config);
      writeFileSync(join(defaults, "MEMORY.md"), "default memory");
      writeFileSync(join(defaults, "SOUL.md"), "default soul");
      writeFileSync(join(config, "SOUL.md"), "config soul");
      const b64 = Buffer.from('{"providers":{}}').toString("base64");
      const env = { PI_MODELS_JSON_B64: b64 };
      run(env, `rt_seed_workspace "${data}" "${defaults}" "${config}"\nrt_write_models_json "${data}/models.json"`);
      assert.equal(readFileSync(join(data, "MEMORY.md"), "utf8"), "default memory");
      assert.equal(readFileSync(join(data, "SOUL.md"), "utf8"), "config soul");
      assert.ok(existsSync(join(data, ".config-hashes", "SOUL.md")));
      for (const d of ["memory", "session-notes", "scratch"]) assert.ok(existsSync(join(data, d)), d);
      assert.equal(readFileSync(join(data, "models.json"), "utf8"), '{"providers":{}}');
      assert.deepEqual(readdirSync(root).sort(), ["config", "data", "defaults"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes models.json at MODELS_JSON_PATH (creating its parent) and nothing at the data dir default", () => {
    const root = mkdtempSync(join(tmpdir(), "seed-"));
    try {
      const target = join(root, "models", "custom", "models.json");
      run({ PI_MODELS_JSON: '{"a":1}' }, `rt_write_models_json "${target}"`);
      assert.equal(readFileSync(target, "utf8"), '{"a":1}\n');
      assert.deepEqual(readdirSync(root), ["models"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("warns and continues when the models path is not writable", () => {
    const out = run({ PI_MODELS_JSON: "{}" }, `rt_write_models_json /proc/nope/models.json`);
    assert.match(out, /WARNING/);
  });

  it("entrypoint derives paths from KNIGHT_DATA_DIR and MODELS_JSON_PATH", () => {
    const src = readFileSync(resolve(import.meta.dirname, "..", "scripts", "entrypoint.sh"), "utf8");
    assert.match(src, /DATA_DIR="\$\{KNIGHT_DATA_DIR:-\/data\}"/);
    assert.match(src, /MODELS_JSON="\$\{MODELS_JSON_PATH:-\$DATA_DIR\/models\.json\}"/);
    assert.doesNotMatch(src.replace(/^\s*#.*$/gm, ""), /"\/data[/"]/);
  });
});
