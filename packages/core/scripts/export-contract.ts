// Writes packages/core/contract/*.schema.json from the TypeBox definitions in src/contract/schema.ts.
import { writeFileSync } from "node:fs";
import { contractSchemaFiles } from "../src/contract/export.ts";

const dir = new URL("../contract/", import.meta.url);
for (const [name, content] of Object.entries(contractSchemaFiles())) {
  writeFileSync(new URL(name, dir), content);
  console.log(`wrote packages/core/contract/${name}`);
}
