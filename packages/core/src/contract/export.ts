/**
 * JSON Schema export of the contract (`npm run contract:export`). The files under
 * `packages/core/contract/` are generated from ./schema.ts; a test fails when they are stale.
 */
import { ActivityEvent, TaskPayload, TaskResult } from "./schema.js";

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

interface Identified {
  $id?: string;
  title?: string;
  description?: string;
}

const SCHEMAS: Record<string, Identified> = {
  "task-payload.schema.json": TaskPayload as Identified,
  "task-result.schema.json": TaskResult as Identified,
  "task-activity-events.schema.json": ActivityEvent as Identified,
};

/** File name (in `packages/core/contract/`) → file content. */
export function contractSchemaFiles(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(SCHEMAS).map(([name, s]) => {
      // $schema and the identity keys first; spreading the schema keeps their position.
      const doc = { $schema: DRAFT, $id: s.$id, title: s.title, description: s.description, ...s };
      return [name, JSON.stringify(doc, null, 2) + "\n"];
    }),
  );
}
