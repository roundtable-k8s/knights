import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { connectionStateFor, findResult } from "../src/nats/index.ts";

describe("connectionStateFor (#149)", () => {
  it("error and unknown statuses leave the state unchanged", () => {
    assert.equal(connectionStateFor("error", true), true);
    assert.equal(connectionStateFor("error", false), false);
    assert.equal(connectionStateFor("ldm", true), true);
  });
  it("disconnect and close mark down, reconnect marks up", () => {
    assert.equal(connectionStateFor("disconnect", true), false);
    assert.equal(connectionStateFor("close", true), false);
    assert.equal(connectionStateFor("reconnect", false), true);
  });
});

describe("findResult timeout (#149)", () => {
  it("returns undefined quickly when the stream calls hang", async () => {
    const never = new Promise<never>(() => {});
    const jsm = { streams: { find: () => never, getMessage: () => never } } as never;
    const t0 = Date.now();
    assert.equal(await findResult(jsm, "res", "t1", 50), undefined);
    assert.ok(Date.now() - t0 < 1000);
  });
  it("returns the stored result when the calls answer", async () => {
    const jsm = { streams: { find: async () => "S", getMessage: async () => ({ json: () => ({ success: true }) }) } } as never;
    assert.deepEqual(await findResult(jsm, "res", "t1"), { success: true });
  });
});
