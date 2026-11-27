import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { installStartupSignalHandlers, mayPullAfterSweep, type StartupSignals } from "../src/startup-signals.ts";

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

  it("honours a signal recorded by the early preload before the handlers were installed", async () => {
    const g = globalThis as { __rtEarlySignal?: string };
    g.__rtEarlySignal = "SIGTERM";
    try {
      const events: string[] = [];
      const signals = installStartupSignalHandlers({
        target: new EventEmitter() as unknown as NodeJS.Process,
        cleanup: () => void events.push("cleanup"),
        exit: (code) => void events.push(`exit:${code}`),
      });
      await sleep(10);
      assert.deepEqual(events, ["cleanup", "exit:0"]);
      assert.equal(signals.requested(), "SIGTERM");
      assert.equal(signals.ready(async () => {}), false);
    } finally {
      delete g.__rtEarlySignal;
    }
  });

  it("early-signals.mjs records SIGTERM that arrives while the app has no handler", async () => {
    const preload = resolve(import.meta.dirname, "..", "scripts", "early-signals.mjs");
    const child = spawn(process.execPath, ["--import", preload, "-e", 'console.log("up");setTimeout(()=>console.log("early="+globalThis.__rtEarlySignal),300)'], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    while (!out.includes("up")) await sleep(20);
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
    assert.match(out, /early=SIGTERM/);
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

  it("the start-up log line goes to the container stdout, not into a redirected phase output", async () => {
    const out = join(tmpdir(), `build-out-${process.pid}-${Date.now()}`);
    const r = await runShell(`rt_run bash -c 'echo building; echo phase-ready >&3; exec sleep 30' >${JSON.stringify(out)}`, "phase-ready");
    const built = readFileSync(out, "utf8");
    rmSync(out, { force: true });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /SIGTERM received during start-up/);
    assert.doesNotMatch(built, /received during start-up/);
  });

  it("rt_run returns the phase's exit status", async () => {
    const r = await runShell(`rt_run false || echo "rc=$?"\nrt_run true && echo ok\necho waiting\nsleep 0.2`, "waiting");
    assert.match(r.out, /rc=1/);
    assert.match(r.out, /ok/);
  });

  it("both entrypoints source it as their first statement and exec the runtime", async () => {
    for (const pkg of ["claude-knight", "pi-knight"]) {
      const src = readFileSync(resolve(import.meta.dirname, "..", "..", pkg, "scripts", "entrypoint.sh"), "utf8");
      const statements = src.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
      assert.equal(statements[0], '. "$(dirname "$0")/startup-signals.sh"', pkg);
      assert.doesNotMatch(src, /mise-\w+\.sh|rt_mise|\/config\/mise\.toml/, `${pkg}: per-knight mise installer removed`);
      assert.doesNotMatch(src, /rt_bootstrap_nix|nix build|nix-lib|nix-env/, `${pkg}: legacy Nix installers removed`);
      assert.equal(statements.at(-1), "exec node --import ./scripts/early-signals.mjs dist/index.js 3>&-", pkg);
      const dockerfile = readFileSync(resolve(import.meta.dirname, "..", "..", pkg, "Dockerfile"), "utf8");
      assert.match(dockerfile, /COPY packages\/core\/scripts\/startup-signals\.sh \.\/scripts\/startup-signals\.sh/, pkg);
      assert.match(dockerfile, /COPY packages\/core\/scripts\/early-signals\.mjs \.\/scripts\/early-signals\.mjs/, pkg);
    }
  });
});

describe("mayPullAfterSweep", () => {
  const fakeSignals = (requested: () => string | null): StartupSignals => ({ requested, ready: () => true });

  it("a SIGTERM during a hanging sweep: resolves false once the sweep settles, so no puller is created", async () => {
    let requested: string | null = null;
    let finishSweep!: () => void;
    const sweep = new Promise<void>((r) => (finishSweep = r));
    let settled = false;
    const may = mayPullAfterSweep(sweep, fakeSignals(() => requested)).then((v) => ((settled = true), v));
    requested = "SIGTERM"; // arrives while the sweep is still pending
    await sleep(5);
    assert.equal(settled, false, "must wait for the sweep");
    finishSweep();
    assert.equal(await may, false);
  });

  it("no signal during the sweep: resolves true", async () => {
    assert.equal(await mayPullAfterSweep(Promise.resolve(), fakeSignals(() => null)), true);
  });

  it("a rejected sweep still rejects, so start-up fails instead of pulling", async () => {
    await assert.rejects(mayPullAfterSweep(Promise.reject(new Error("sweep failed")), fakeSignals(() => null)), /sweep failed/);
  });
});
