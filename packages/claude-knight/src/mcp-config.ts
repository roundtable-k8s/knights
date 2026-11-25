/**
 * Tool and MCP server settings shared by both runtimes.
 */
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnightConfig } from "./config.js";
import { log } from "./logger.js";

/**
 * Built-in tools that need a human, schedule work outside the task, or belong to
 * interactive Claude Code. An unattended knight must not reach for them.
 */
export const DISALLOWED_TOOLS = [
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "EnterWorktree",
  "ExitWorktree",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "PushNotification",
  "SendUserMessage",
  "SendUserFile",
  "ReadNotifications",
  "Monitor",
  "ShowOnboardingRolePicker",
];

/** Built-ins to make sure are present (native builds otherwise fold search into Bash). */
export const EXTRA_BUILTINS = ["Grep", "Glob", "WebFetch", "WebSearch"];

/** External MCP servers: /config/mcp.json (ConfigMap) then MCP_SERVERS_JSON (env) on top. */
export function loadMcpServers(config: KnightConfig): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  const merge = (source: string, raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      const map = parsed?.mcpServers ?? parsed; // accept .mcp.json shape or a bare map
      if (map && typeof map === "object" && !Array.isArray(map)) Object.assign(servers, map);
      else log.warn("Ignoring MCP config that is not an object", { source });
    } catch (err) {
      log.warn("Ignoring unparseable MCP config", { source, error: String(err) });
    }
  };
  const file = join(config.configDir, "mcp.json");
  if (existsSync(file)) merge(file, readFileSync(file, "utf8"));
  if (config.mcpServersJson) merge("MCP_SERVERS_JSON", config.mcpServersJson);
  delete servers["roundtable"]; // reserved for the built-in NATS tools
  return servers;
}
