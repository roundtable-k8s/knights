import { Writable } from "node:stream";
import { setLogStream } from "../../src/logger.js";

export interface LogCapture {
  /** Raw chunks written to the log stream. */
  chunks: string[];
  /** Everything logged so far as one string. */
  text(): string;
  /** Every logged line parsed as JSON. */
  lines(): Array<Record<string, any>>;
  /** The first logged entry whose msg equals the given message. */
  find(msg: string): Record<string, any> | undefined;
}

/** Route log output into memory (call initLogger afterwards as usual) and return readers for it. */
export function captureLogs(): LogCapture {
  const chunks: string[] = [];
  setLogStream(new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } }));
  const text = (): string => chunks.join("");
  const lines = (): Array<Record<string, any>> => text().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { chunks, text, lines, find: (msg) => lines().find((l) => l.msg === msg) };
}
