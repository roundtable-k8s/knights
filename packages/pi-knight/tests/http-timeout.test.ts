import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import * as undici from "undici";
import { configureHttpTimeouts } from "../src/http-timeout.js";

async function slowServer(delayMs: number): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((_req, res) => {
    setTimeout(() => res.end("ok"), delayMs);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, close: () => server.closeAllConnections() || server.close() };
}

describe("configureHttpTimeouts", () => {
  const original = undici.getGlobalDispatcher();
  afterEach(() => undici.setGlobalDispatcher(original));

  it("applies the configured header timeout to global fetch", async () => {
    const srv = await slowServer(2500);
    try {
      configureHttpTimeouts(500);
      await assert.rejects(fetch(srv.url), (e: unknown) => {
        const cause = (e as { cause?: { code?: string } }).cause;
        return cause?.code === "UND_ERR_HEADERS_TIMEOUT";
      });
      configureHttpTimeouts(10000);
      const res = await fetch(srv.url);
      assert.equal(await res.text(), "ok");
    } finally {
      srv.close();
    }
  });
});
