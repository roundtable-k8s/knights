import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "mise-init.sh");

/** Runs mise-init.sh with a fake `mise` that records its invocations, then hangs like a blocked network. */
function run(miseToml: string | undefined, timeout = "1", script = SCRIPT) {
  const dir = mkdtempSync(join(tmpdir(), "mise-init-"));
  try {
    const config = join(dir, "config");
    const bin = join(dir, "bin");
    mkdirSync(config);
    mkdirSync(bin);
    if (miseToml !== undefined) writeFileSync(join(config, "mise.toml"), miseToml);
    const marker = join(dir, "mise-called");
    writeFileSync(
      join(bin, "mise"),
      `#!/bin/sh\necho "$@" >> ${marker}\nif [ "$1" = install ]; then echo 'mise ERROR HTTP timed out for https://mise-versions.jdx.dev/data/x.gz'; exec sleep 30; fi\nexit 0\n`,
    );
    chmodSync(join(bin, "mise"), 0o755);
    const started = Date.now();
    const r = spawnSync("sh", [script], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONFIG_DIR: config, MISE_INSTALL_TIMEOUT: timeout },
      encoding: "utf8",
    });
    return { ...r, elapsed: Date.now() - started, miseCalled: existsSync(marker) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("mise-init: empty mise.toml makes no mise call", () => {
  for (const toml of ["", "# nothing\n\n", "[tools]\n# none\n", '[env]\nFOO = "bar"\n']) {
    const r = run(toml, "1");
    assert.equal(r.status, 0);
    assert.equal(r.miseCalled, false, JSON.stringify(toml));
    assert.ok(r.elapsed < 5000);
    assert.match(r.stdout, /skipping mise install/);
  }
});

test("mise-init: unreachable host gives up within the timeout, names the host, exits 0", () => {
  const r = run('[tools]\nripgrep = "latest"\n', "1");
  assert.equal(r.status, 0);
  assert.equal(r.miseCalled, true);
  assert.ok(r.elapsed < 10000, `took ${r.elapsed}ms`);
  assert.match(r.stdout, /WARNING: mise install gave up .*could not reach mise-versions\.jdx\.dev/);
});
