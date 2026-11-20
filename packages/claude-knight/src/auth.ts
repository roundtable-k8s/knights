import type { AuthMode } from "./config.js";

/**
 * Credential handling for the Claude Code child process.
 *
 * Claude Code picks the first credential it finds, and API keys outrank the
 * OAuth token from `claude setup-token`. A stray ANTHROPIC_API_KEY in the pod
 * (an envFrom that pulls in a shared secret, say) would silently turn a
 * subscription knight into a pay-per-token one. So the child environment is
 * built from an allowlist-by-removal: in subscription mode every API-key
 * credential is stripped; in api mode the OAuth token is stripped. The knight
 * refuses to run tasks when the credential for its mode is missing.
 */

/** Env vars that make Claude Code bill per token instead of to the Claude plan. */
export const API_CREDENTIAL_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

/** Env vars that authenticate against a Claude plan. */
export const SUBSCRIPTION_CREDENTIAL_VARS = ["CLAUDE_CODE_OAUTH_TOKEN"] as const;

export interface AuthCheck {
  ok: boolean;
  /** Human-readable reason when ok is false. */
  reason?: string;
  /** Non-fatal notes worth logging (e.g. a stripped conflicting credential). */
  warnings: string[];
}

function present(env: NodeJS.ProcessEnv, name: string): boolean {
  const v = env[name];
  return typeof v === "string" && v.trim().length > 0;
}

export function checkAuth(mode: AuthMode, env: NodeJS.ProcessEnv = process.env): AuthCheck {
  const warnings: string[] = [];
  if (mode === "subscription") {
    const strayApi = API_CREDENTIAL_VARS.filter((v) => present(env, v));
    if (strayApi.length > 0) {
      warnings.push(
        `Ignoring ${strayApi.join(", ")} in subscription mode so tasks bill to the Claude plan, not the API`,
      );
    }
    if (!present(env, "CLAUDE_CODE_OAUTH_TOKEN")) {
      return {
        ok: false,
        reason:
          "CLAUDE_AUTH_MODE=subscription but CLAUDE_CODE_OAUTH_TOKEN is not set (generate one with `claude setup-token`)",
        warnings,
      };
    }
    const token = env["CLAUDE_CODE_OAUTH_TOKEN"]!.trim();
    if (!token.startsWith("sk-ant-oat")) {
      warnings.push("CLAUDE_CODE_OAUTH_TOKEN does not look like a setup-token (expected sk-ant-oat… prefix)");
    }
    return { ok: true, warnings };
  }

  // api mode
  if (present(env, "CLAUDE_CODE_OAUTH_TOKEN")) {
    warnings.push("Ignoring CLAUDE_CODE_OAUTH_TOKEN in api mode");
  }
  if (!present(env, "ANTHROPIC_API_KEY") && !present(env, "ANTHROPIC_AUTH_TOKEN")) {
    return {
      ok: false,
      reason: "CLAUDE_AUTH_MODE=api but neither ANTHROPIC_API_KEY nor ANTHROPIC_AUTH_TOKEN is set",
      warnings,
    };
  }
  return { ok: true, warnings };
}

/**
 * Build the environment for the Claude Code child process: the pod env minus
 * the credentials of the other mode, plus knight-specific settings.
 */
export function buildChildEnv(
  mode: AuthMode,
  extra: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const child: Record<string, string | undefined> = { ...env };
  const strip: readonly string[] = mode === "subscription" ? API_CREDENTIAL_VARS : SUBSCRIPTION_CREDENTIAL_VARS;
  for (const name of strip) delete child[name];
  // Also drop ANTHROPIC_BASE_URL in subscription mode: plan tokens only work
  // against Anthropic's own endpoint, and a gateway URL here would just 401.
  if (mode === "subscription") delete child["ANTHROPIC_BASE_URL"];
  return { ...child, ...extra };
}
