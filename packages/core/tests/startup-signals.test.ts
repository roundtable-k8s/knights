import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { installStartupSignalHandlers } from "../src/startup-signals.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("installStartupSignalHandlers", () => {
  it("a signal before ready() cleans up and exits 0; ready() then refuses to start pulling", async () => {
    const target = new EventEmitter();
    const events: string[] = [];
    const signals = installStartupSignalHandlers({
      target: target as unknown as NodeJS.Process,
      cleanup: async () => void events.push("cleanup"),
      exit: (code) => void events.push(`exit:${code}`),
    });
    assert.equal(signals.requested(), null);
    target.emit("SIGTERM");
    target.emit("SIGTERM"); // a second signal while exiting changes nothing
    target.emit("SIGINT");
    await sleep(10);
    assert.deepEqual(events, ["cleanup", "exit:0"]);
    assert.equal(signals.requested(), "SIGTERM");
    let shutdownCalled = false;
    assert.equal(signals.ready(async () => void (shutdownCalled = true)), false);
    target.emit("SIGTERM");
    await sleep(10);
    assert.equal(shutdownCalled, false);
  });

  it("after ready() a signal runs the full shutdown, not the start-up exit", async () => {
    const target = new EventEmitter();
    const events: string[] = [];
    const signals = installStartupSignalHandlers({
      target: target as unknown as NodeJS.Process,
      cleanup: () => void events.push("cleanup"),
      exit: (code) => void events.push(`exit:${code}`),
    });
    assert.equal(signals.ready(async (s) => void events.push(`shutdown:${s}`)), true);
    target.emit("SIGINT");
    await sleep(10);
    assert.deepEqual(events, ["shutdown:SIGINT"]);
    assert.equal(signals.requested(), "SIGINT");
  });

  it("exits even when cleanup hangs or throws", async () => {
    for (const cleanup of [() => new Promise<void>(() => {}), () => Promise.reject(new Error("boom"))]) {
      const target = new EventEmitter();
      let code: number | null = null;
      installStartupSignalHandlers({ target: target as unknown as NodeJS.Process, cleanup, cleanupTimeoutMs: 50, exit: (c) => void (code = c) });
      target.emit("SIGTERM");
      await sleep(150);
      assert.equal(code, 0);
    }
  });
});

const LIB = resolve(import.meta.dirname, "..", "scripts", "startup-signals.sh");

/** Runs a bash script that sources startup-signals.sh, sends SIGTERM once `waitFor` is printed. */
async function runShell(body: string, waitFor: string) {
  const dir = mkdtempSync(join(tmpdir(), "startup-signals-"));
  const script = join(dir, "entry.sh");
  writeFileSync(script, `#!/bin/bash\n. ${JSON.stringify(LIB)}\nset -eo pipefail\n${body}\n`);
  // Own process group, like PID 1 in a container.
  const child = spawn("bash", [script], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
  const deadline = Date.now() + 10_000;
  while (!out.includes(waitFor) && Date.now() < deadline) await sleep(20);
  assert.ok(out.includes(waitFor), `never printed ${waitFor}: ${out}`);
  const sentAt = Date.now();
  child.kill("SIGTERM");
  const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const r = await exited;
  clearTimeout(timeout);
  rmSync(dir, { recursive: true, force: true });
  return { ...r, out, elapsed: Date.now() - sentAt };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("startup-signals.sh (entrypoint)", () => {
  it("SIGTERM during a slow phase exits 0 at once, stops the phase and never starts the knight", async () => {
    const r = await runShell(
      `echo "Phase 3: building"\nrt_run bash -c 'echo "phase-pid $$"; exec sleep 30'\necho "Phase 5: Starting knight"`,
      "phase-pid",
    );
    assert.equal(r.code, 0, r.out);
    assert.ok(r.elapsed < 3000, `took ${r.elapsed}ms`);
    assert.match(r.out, /SIGTERM received during start-up/);
    assert.doesNotMatch(r.out, /Starting knight/);
    const pid = Number(/phase-pid (\d+)/.exec(r.out)![1]);
    await sleep(100);
    assert.equal(alive(pid), false, "the slow phase was left running");
  });

  it("SIGTERM during a slow shell function phase (output piped) exits at once", async () => {
    const r = await runShell(
      `slow() { echo ready; sleep 30 | sed 's/^/  /'; }\nrt_run slow || echo "non-fatal"\necho "Phase 5: Starting knight"`,
      "ready",
    );
    assert.equal(r.code, 0, r.out);
    assert.ok(r.elapsed < 3000, `took ${r.elapsed}ms`);
    assert.doesNotMatch(r.out, /non-fatal|Starting knight/);
  });

  it("rt_run returns the phase's exit status", async () => {
    const r = await runShell(`rt_run false || echo "rc=$?"\nrt_run true && echo ok\necho waiting\nsleep 0.2`, "waiting");
    assert.match(r.out, /rc=1/);
    assert.match(r.out, /ok/);
  });

  it("both entrypoints source it as their first statement, run slow phases through rt_run and exec the runtime", async () => {
    const { readFileSync } = await import("node:fs");
    for (const pkg of ["claude-knight", "pi-knight"]) {
      const src = readFileSync(resolve(import.meta.dirname, "..", "..", pkg, "scripts", "entrypoint.sh"), "utf8");
      const statements = src.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
      assert.equal(statements[0], '. "$(dirname "$0")/startup-signals.sh"', pkg);
      for (const phase of ["rt_run rt_bootstrap_nix_bounded", "rt_run timeout \"$STARTUP_NIX_TIMEOUT\" nix build", "rt_run rt_mise"]) assert.ok(src.includes(phase), `${pkg}: ${phase}`);
      assert.equal(statements.at(-1), "exec node dist/index.js", pkg);
      const dockerfile = readFileSync(resolve(import.meta.dirname, "..", "..", pkg, "Dockerfile"), "utf8");
      assert.match(dockerfile, /COPY packages\/core\/scripts\/startup-signals\.sh \.\/scripts\/startup-signals\.sh/, pkg);
    }
  });
});
