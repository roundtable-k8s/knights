/**
 * find_knights — who at my table can do X? Reads the agent cards through the core roster
 * (KV watch cache, direct read before it loads) and marks knights with a live pod.
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { FIND_KNIGHTS_DESCRIPTION, FIND_KNIGHTS_PARAMS, FIND_KNIGHTS_PROMPT_LINE, findKnightsText } from "@roundtable/knight-core";

const FindKnightsParams = Type.Object({
  query: Type.Optional(Type.String({ description: FIND_KNIGHTS_PARAMS.query })),
  domain: Type.Optional(Type.String({ description: FIND_KNIGHTS_PARAMS.domain })),
  skill: Type.Optional(Type.String({ description: FIND_KNIGHTS_PARAMS.skill })),
  includeSuspended: Type.Optional(Type.Boolean({ description: FIND_KNIGHTS_PARAMS.includeSuspended })),
});

export const findKnightsTool = defineTool({
  name: "find_knights",
  label: "Find Knights",
  description: FIND_KNIGHTS_DESCRIPTION,
  promptSnippet: FIND_KNIGHTS_PROMPT_LINE,
  parameters: FindKnightsParams,
  async execute(_toolCallId, params): Promise<AgentToolResult<void>> {
    const { text } = await findKnightsText(params);
    return { content: [{ type: "text", text }], details: undefined };
  },
});
