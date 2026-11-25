/**
 * `node dist/index.js hook pretooluse` — the command hook the cli runtime
 * registers in its generated settings.json. Claude Code writes the hook input
 * as JSON on stdin; a deny decision goes back as JSON on stdout with exit 0.
 * No output means no opinion (the call proceeds). Input that is not JSON exits
 * 2, which Claude Code treats as a block: the guardrail fails closed.
 */
import { decidePreToolUse } from "./guardrails.js";

export class HookInputError extends Error {}

/** Returns the JSON to print (empty for no opinion); throws HookInputError on unreadable input. */
export function handlePreToolUseHook(stdin: string): string {
  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch {
    throw new HookInputError("hook input is not JSON");
  }
  if (!input || typeof input !== "object") throw new HookInputError("hook input is not a JSON object");
  const decision = decidePreToolUse(input as Record<string, unknown>);
  return decision ? JSON.stringify(decision.output) : "";
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function runHookCommand(event: string | undefined): Promise<number> {
  if (event !== "pretooluse") {
    process.stderr.write(`claude-knight hook: unknown event "${event ?? ""}" (expected "pretooluse")\n`);
    return 0; // no opinion rather than an error that would surface as a hook failure
  }
  let out: string;
  try {
    out = handlePreToolUseHook(await readStdin());
  } catch (err) {
    process.stderr.write(`claude-knight hook: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (out) process.stdout.write(out + "\n");
  return 0;
}
