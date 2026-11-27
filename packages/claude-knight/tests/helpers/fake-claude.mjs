#!/usr/bin/env node
// Stand-in for the claude binary in cli runtime unit tests. Records how it was
// invoked, then replays a stream-json fixture.
//   FAKE_CLAUDE_RECORD   file to write {argv, stdin, env, files} to
//   FAKE_CLAUDE_FIXTURE  stream-json file to print on stdout
//   FAKE_CLAUDE_EXIT     exit code (default 0)
//   FAKE_CLAUDE_STDERR   text to print on stderr
//   FAKE_CLAUDE_GRANDCHILD  file to write the pid of a `sleep 600` child (own session, like the shells of the real CLI) to
//   FAKE_CLAUDE_HANG=1   never exit (abort tests)
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const argv = process.argv.slice(2);
const fileArg = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 && existsSync(argv[i + 1]) ? readFileSync(argv[i + 1], "utf8") : undefined;
};
if (process.env.FAKE_CLAUDE_RECORD) {
  writeFileSync(
    process.env.FAKE_CLAUDE_RECORD,
    JSON.stringify({
      argv,
      cwd: process.cwd(),
      stdin: Buffer.concat(chunks).toString("utf8"),
      env: process.env,
      files: {
        systemPrompt: fileArg("--append-system-prompt-file"),
        mcp: fileArg("--mcp-config"),
        settings: fileArg("--settings"),
      },
    }),
  );
}
if (process.env.FAKE_CLAUDE_GRANDCHILD) {
  const gc = spawn("sleep", ["600"], { stdio: "ignore", detached: true });
  gc.unref();
  writeFileSync(process.env.FAKE_CLAUDE_GRANDCHILD, String(gc.pid));
}
if (process.env.FAKE_CLAUDE_FIXTURE) process.stdout.write(readFileSync(process.env.FAKE_CLAUDE_FIXTURE, "utf8"));
if (process.env.FAKE_CLAUDE_STDERR) process.stderr.write(process.env.FAKE_CLAUDE_STDERR);
if (process.env.FAKE_CLAUDE_HANG === "1") setInterval(() => {}, 1000);
else process.exitCode = Number(process.env.FAKE_CLAUDE_EXIT ?? 0);
