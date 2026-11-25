import { test } from "node:test";
import assert from "node:assert/strict";
import { KNIGHT_CORE_VERSION } from "../src/index.js";

test("core exports its placeholder constant", () => {
  assert.equal(KNIGHT_CORE_VERSION, "0.0.0");
});
