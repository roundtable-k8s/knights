import { agentShellEnv, traceparentEnv } from "@roundtable/knight-core";
import type { AuthMode, Runtime } from "./config.js";

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
 *
 * Egress injection (optional, subscription mode): the pod holds no real token.
 * ANTHROPIC_AUTH_TOKEN is a placeholder, ANTHROPIC_CUSTOM_HEADERS carries the
 * OAuth beta header, and an egress gateway swaps the real setup-token into the
 * Authorization header on the way to api.anthropic.com (the pattern kagent's
 * Claude Code harness uses). In that mode the placeholder, the header and any
 * ANTHROPIC_BASE_URL are passed through; ANTHROPIC_API_KEY is still stripped.
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

/** The beta header value Anthropic requires on OAuth (plan) bearer tokens. */
export const OAUTH_BETA = "oauth-2025-04-20";

/**
 * Set by the Agent SDK to tag its child process. A knight running the CLI is
 * not an SDK host, so these never reach `claude -p`.
 */
const SDK_HOST_VARS = ["CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_CLIENT_APP", "CLAUDE_AGENT_SDK_VERSION"] as const;

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

/**
 * True when the pod is set up for egress token injection: a bearer
 * ANTHROPIC_AUTH_TOKEN (the placeholder) plus ANTHROPIC_CUSTOM_HEADERS that
 * carries the OAuth beta.
 */
export function egressInjection(env: NodeJS.ProcessEnv = process.env): boolean {
  return present(env, "ANTHROPIC_AUTH_TOKEN") && (env["ANTHROPIC_CUSTOM_HEADERS"] ?? "").includes(OAUTH_BETA);
}

export function checkAuth(mode: AuthMode, env: NodeJS.ProcessEnv = process.env): AuthCheck {
  const warnings: string[] = [];
  if (mode === "subscription") {
    const egress = egressInjection(env);
    const strayApi = API_CREDENTIAL_VARS.filter((v) => present(env, v) && !(egress && v === "ANTHROPIC_AUTH_TOKEN"));
    if (strayApi.length > 0) {
      warnings.push(
        `Ignoring ${strayApi.join(", ")} in subscription mode so tasks bill to the Claude plan, not the API`,
      );
    }
    if (egress) {
      if (present(env, "CLAUDE_CODE_OAUTH_TOKEN")) {
        warnings.push("Egress injection is set up (ANTHROPIC_AUTH_TOKEN + oauth beta header); ignoring CLAUDE_CODE_OAUTH_TOKEN");
      }
      return { ok: true, warnings };
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
 * A Claude plan token may drive the official Claude Code CLI, not the Agent
 * SDK, so subscription mode needs the cli runtime. Returns the reason the
 * combination is refused, or undefined when it is fine.
 */
export function checkRuntime(mode: AuthMode, runtime: Runtime): string | undefined {
  if (mode === "subscription" && runtime === "sdk") {
    return (
      "CLAUDE_RUNTIME=sdk is not allowed with CLAUDE_AUTH_MODE=subscription: a Claude plan token may only be used " +
      "with the official Claude Code CLI. Unset CLAUDE_RUNTIME (subscription defaults to cli) or use CLAUDE_AUTH_MODE=api"
    );
  }
  return undefined;
}

/**
 * Build the environment for the Claude Code child process: the pod env minus
 * the credentials of the other mode, plus knight-specific settings.
 */
export function buildChildEnv(
  mode: AuthMode,
  extra: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
  runtime: Runtime = "sdk",
): Record<string, string | undefined> {
  const child: Record<string, string | undefined> = agentShellEnv(env);
  const egress = mode === "subscription" && egressInjection(env);
  let strip: readonly string[] = mode === "subscription" ? API_CREDENTIAL_VARS : SUBSCRIPTION_CREDENTIAL_VARS;
  // With egress injection the placeholder bearer is the credential, and the
  // real token never enters the pod, so there is no OAuth token to prefer.
  if (egress) strip = [...strip.filter((v) => v !== "ANTHROPIC_AUTH_TOKEN"), ...SUBSCRIPTION_CREDENTIAL_VARS];
  for (const name of strip) delete child[name];
  // Drop ANTHROPIC_BASE_URL in subscription mode: plan tokens only work against
  // Anthropic's own endpoint, and a gateway URL here would just 401. With egress
  // injection the token is a placeholder, so a gateway URL is allowed.
  if (mode === "subscription" && !egress) delete child["ANTHROPIC_BASE_URL"];
  if (runtime === "cli") for (const name of SDK_HOST_VARS) delete child[name];
  // Parent for the child's own telemetry: the active knight.task span (empty when tracing is off).
  return { ...child, ...traceparentEnv(), ...extra };
}
