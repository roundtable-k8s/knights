import * as undici from "undici";

/**
 * Raise Node's own HTTP timeouts to `timeoutMs`.
 *
 * Node's global fetch (undici) gives up waiting for response headers after 300 s and
 * between body chunks after 300 s, whatever timeout the OpenAI client asks for. The pi SDK
 * only lifts that in its CLI entry point, which a knight does not use, so a slow local
 * model (cold load, long prompt) would still be cut off at 5 minutes with
 * UND_ERR_HEADERS_TIMEOUT. Call once at start-up, before any model request.
 */
export function configureHttpTimeouts(timeoutMs: number): void {
  undici.setGlobalDispatcher(
    new undici.EnvHttpProxyAgent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs }),
  );
  // Keep fetch and the dispatcher on the same undici implementation (as the SDK does).
  undici.install?.();
}
