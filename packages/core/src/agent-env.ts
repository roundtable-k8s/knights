/**
 * Environment hygiene for the shells an agent opens.
 *
 * The images used to set NODE_ENV=production for the runtime process. Every
 * shell the agent opens inherited it, so `npm ci` silently skipped devDependencies
 * (typescript, tsx, eslint ...) in the repo the knight was working on.
 */
type Env = Record<string, string | undefined>;

/** Variables that make npm/node tooling omit dev dependencies. */
export function leaksProductionMode(env: Env): string[] {
  const names: string[] = [];
  if (env["NODE_ENV"] === "production") names.push("NODE_ENV");
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === "npm_config_omit" || name.toLowerCase() === "npm_config_production") names.push(name);
  }
  return names;
}

/** A copy of `env` that is safe to hand to agent tool shells (no production-mode switches). */
export function agentShellEnv<T extends Env>(env: T): T {
  const out = { ...env };
  for (const name of leaksProductionMode(out)) delete out[name];
  return out;
}

/** Remove the production-mode switches from `env` in place (default: this process). */
export function scrubAgentEnv(env: Env = process.env): void {
  for (const name of leaksProductionMode(env)) delete env[name];
}
