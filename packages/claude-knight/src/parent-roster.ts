import { initRoster, log, getConnection, type Roster } from "@roundtable/knight-core";
import type { Runtime } from "./config.js";

/**
 * Start the agent-card roster (a KV watch on <table>.*) in the parent process, but only for the sdk
 * runtime, where find_knights / nats_request run in-process. In the cli runtime the stdio MCP child
 * starts its own roster, so a parent watch would be one unused KV watch and card cache per pod.
 */
export function startParentRoster(
  runtime: Runtime,
  env: NodeJS.ProcessEnv,
  knightName: string,
  init: typeof initRoster = initRoster,
): Roster | null {
  if (runtime !== "sdk") {
    log.debug("Skipping parent roster: the stdio MCP process runs its own", { runtime });
    return null;
  }
  const roster = init(env, knightName, getConnection);
  void roster?.start();
  return roster;
}
