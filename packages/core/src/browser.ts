/**
 * One argv-based runner for the agent-browser CLI, shared by pi-knight and
 * claude-knight. Arguments are passed as an argv array to execFile (no shell),
 * so model- or page-supplied text can never be interpreted as commands.
 */
import { execFile } from "node:child_process";

export function browserEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["BROWSER_ENABLED"] === "true";
}

const CDP_URL = () => process.env["BROWSER_CDP_URL"] || "http://localhost:9222";
const BIN = () => process.env["AGENT_BROWSER_BIN"] || "agent-browser";
export const BROWSER_MAX_OUTPUT = 100_000;

export type ExecFn = (bin: string, args: string[], timeoutMs: number) => Promise<string>;

const defaultExec: ExecFn = (bin, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout.trim());
    });
  });

let exec: ExecFn = defaultExec;
/** Test hook. */
export function setBrowserExec(fn: ExecFn | null): void {
  exec = fn ?? defaultExec;
}

/** Reconnect first: the agent-browser daemon can die between calls; connect is idempotent. */
export async function runBrowser(args: string[], timeoutMs = 30_000): Promise<string> {
  try {
    await exec(BIN(), ["connect", CDP_URL()], 10_000);
  } catch {
    // best effort — the command may still work through an existing daemon
  }
  const out = await exec(BIN(), args, timeoutMs);
  return out.length > BROWSER_MAX_OUTPUT
    ? `${out.slice(0, BROWSER_MAX_OUTPUT)}\n…[truncated ${out.length - BROWSER_MAX_OUTPUT} chars]`
    : out;
}
