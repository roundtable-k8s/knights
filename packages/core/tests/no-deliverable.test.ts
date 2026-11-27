import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { describeNoDeliverable, NO_DELIVERABLE_MESSAGE } from "../src/no-deliverable.ts";

describe("describeNoDeliverable", () => {
  it("is the bare sentence without facts", () => {
    assert.equal(describeNoDeliverable(), NO_DELIVERABLE_MESSAGE);
  });
  it("adds turns, tool calls, ending and advice", () => {
    assert.equal(
      describeNoDeliverable({ turns: 3, toolCalls: 5, ended: "the last message had only tool calls" }),
      "Agent produced no deliverable output (3 turns, 5 tool calls; the last message had only tool calls). End the task with a written answer.",
    );
  });
  it("singularises and tolerates missing parts", () => {
    assert.match(describeNoDeliverable({ turns: 1, toolCalls: 1 }), /\(1 turn, 1 tool call\)/);
    assert.match(describeNoDeliverable({ ended: "stopped: length" }), /\(stopped: length\)/);
  });
});
