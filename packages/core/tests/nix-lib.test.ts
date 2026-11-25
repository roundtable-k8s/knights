import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const run = (pkg: string, body: string, env: Record<string, string> = {}) =>
  spawnSync("bash", ["-c", `. "${resolve(import.meta.dirname, "../..", pkg, "scripts/nix-lib.sh")}"; ${body}`], {
    encoding: "utf8",
    env: { ...process.env, HOME: "/tmp", ...env },
  });

for (const pkg of ["claude-knight", "pi-knight"]) {
  describe(`${pkg} rt_bootstrap_nix_bounded`, () => {
    it("passes NIX_CONF and NIX_PROFILE to the child shell", () => {
      const r = run(
        pkg,
        'rt_bootstrap_nix() { echo "conf=$NIX_CONF profile=$NIX_PROFILE"; }; rt_restore_profile() { :; }; rt_bootstrap_nix_bounded',
      );
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /conf=\/nix\/etc\/nix\/nix\.conf profile=\S+/);
    });

    it("returns 124 when the bootstrap exceeds STARTUP_NIX_TIMEOUT", () => {
      const r = run(pkg, "rt_bootstrap_nix() { sleep 5; }; rt_restore_profile() { :; }; rt_bootstrap_nix_bounded", {
        STARTUP_NIX_TIMEOUT: "1",
      });
      assert.equal(r.status, 124);
    });
  });
}
