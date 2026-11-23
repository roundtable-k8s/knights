import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnightConfig } from "./config.js";
import { browserEnabled } from "./browser.js";

/**
 * Text appended to Claude Code's own system prompt.
 *
 * pi-knight's resource loader reads AGENTS.md/SOUL.md from the workspace; Claude
 * Code reads CLAUDE.md instead. Rather than depend on file-name conventions, the
 * knight's personality and operating contract are appended here explicitly, read
 * fresh for each task so ConfigMap changes apply without a restart. The PVC copy
 * wins over /config so the knight's own edits survive (the entrypoint re-seeds
 * from /config only when the ConfigMap content changes, same as pi-knight).
 */
const PERSONALITY_FILES = ["SOUL.md", "IDENTITY.md", "AGENTS.md", "TOOLS.md"] as const;

/** Per-file cap so a runaway MEMORY-style file can't eat the context window. */
const MAX_FILE_CHARS = 20_000;

function readFirst(paths: string[]): string | undefined {
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const text = readFileSync(p, "utf8").trim();
        if (text) return text.length > MAX_FILE_CHARS ? `${text.slice(0, MAX_FILE_CHARS)}\n…[truncated]` : text;
      } catch {
        // unreadable — try the next location
      }
    }
  }
  return undefined;
}

export function buildPreamble(config: KnightConfig, taskDir?: string): string {
  const model = config.claudeModel ?? "the Claude plan default";
  return `You are ${config.knightName}, a Knight of the Round Table.
You are a specialized AI agent running as a Kubernetes pod in the Round Table fleet,
running on Claude Code (claude-knight runtime). Model: ${model}.

<runtime_context>
Knight: ${config.knightName}
Workspace: ${config.workDir} (persistent PVC — survives restarts)${
    taskDir ? `\nWorking directory for this task: ${taskDir} (private to this task, removed when it ends; clone repos and put scratch files here; memory files stay under ${config.workDir})` : ""
  }
Skills: available through the Skill tool (synced from the arsenal, read-only)
Vault: /vault if mounted (Derek's Obsidian vault — write only to Briefings/ and Roundtable/)
Knight-to-knight: mcp__roundtable__nats_request (ask another knight), mcp__roundtable__nats_publish (alerts/reports)${
    browserEnabled()
      ? "\nBrowser: headless Chrome sidecar via mcp__roundtable__browser_* (open → snapshot → click/fill → get_text/screenshot); the agent-browser CLI also works from Bash"
      : ""
  }
</runtime_context>

Arsenal skills were written for pi-knight. Where a skill says nats_request / nats_publish,
use mcp__roundtable__nats_request / mcp__roundtable__nats_publish; where it says
spawn_subagent, use the Agent tool; browser_* means mcp__roundtable__browser_*.

<unattended>
Nobody is watching this session. There is no human to answer questions or approve
plans. Never ask for clarification — take the most reasonable reading of the task,
state the assumption in your final answer, and complete the work.
</unattended>

<critical_rules>
1. Read MEMORY.md (if present) at the start of each task for accumulated context.
2. Log your work to memory/YYYY-MM-DD.md after each task.
3. NEVER truncate results. If the task asks for full output, provide full output.
4. If a tool call fails, understand WHY before retrying — don't loop on the same error.
5. Your final message IS the deliverable. The runtime publishes it as the task result.
   When asked for a report, the final message is the report — never describe what you
   would write. Always end with a plain-text message stating the result.
</critical_rules>`;
}

export function buildAppendPrompt(config: KnightConfig, taskDir?: string): string {
  const sections: string[] = [buildPreamble(config, taskDir)];
  for (const file of PERSONALITY_FILES) {
    const text = readFirst([join(config.workDir, file), join(config.configDir, file)]);
    if (text) sections.push(`<knight_file name="${file}">\n${text}\n</knight_file>`);
  }
  return sections.join("\n\n");
}
