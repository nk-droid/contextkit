import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toClaudeSchema } from "../scripts/claude-schema.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("converts the portable 2020-12 schema for Claude CLI", () => {
  const portable = JSON.parse(
    readFileSync(resolve(projectRoot, "schemas/repo-graph.schema.json"), "utf8"),
  );
  const converted = toClaudeSchema(portable);
  const serialized = JSON.stringify(converted);

  assert.equal(converted.$schema, undefined);
  assert.equal(converted.$id, undefined);
  assert.equal(converted.$defs, undefined);
  assert.ok(converted.definitions);
  assert.doesNotMatch(serialized, /#\/\$defs\//);
  assert.match(serialized, /#\/definitions\/graph/);
  assert.equal(portable.$schema, "https://json-schema.org/draft/2020-12/schema");
});
