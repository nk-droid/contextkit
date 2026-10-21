import test from "node:test";
import assert from "node:assert/strict";
import Ajv from "ajv";
import { toCodexSchema } from "../scripts/codex-schema.mjs";
import { SLICES } from "../src/analysis/slices/plan-slices.mjs";

test("both Codex slice schemas use bare references accepted by the response-format validator", () => {
  for (const slice of Object.values(SLICES)) {
    const original = slice.loadSchema();
    const before = structuredClone(original);
    const converted = toCodexSchema(original);
    let references = 0;
    function check(value) {
      if (!value || typeof value !== "object") return;
      if (value.$ref) {
        references += 1;
        assert.deepEqual(Object.keys(value), ["$ref"], `${slice.id}: ${value.$ref}`);
      }
      if (value.pattern) assert.doesNotMatch(value.pattern, /\(\?(?:[=!]|<[=!])/);
      Object.values(value).forEach(check);
    }
    check(converted);
    assert.ok(references > 0);
    assert.deepEqual(original, before);
    new Ajv({ strict: true, strictRequired: true, validateFormats: false }).compile(converted);
  }
});

test("removing reference annotations preserves enum constraints and the original schema", () => {
  const original = {
    type: "object", additionalProperties: false,
    properties: { lifecycle: { $ref: "#/$defs/Lifecycle", description: "Lifecycle state", title: "Lifecycle" } },
    $defs: { Lifecycle: { type: "string", enum: ["active", "unknown"] } },
  };
  const converted = toCodexSchema(original);
  assert.deepEqual(converted.properties.lifecycle, { $ref: "#/definitions/Lifecycle" });
  assert.equal(original.properties.lifecycle.description, "Lifecycle state");
  const validate = new Ajv().compile(converted);
  assert.equal(validate({ lifecycle: "active" }), true);
  assert.equal(validate({ lifecycle: "invented" }), false);
  assert.equal(validate({}), false);
});

test("reference constraints are never silently discarded", () => {
  assert.throws(() => toCodexSchema({
    type: "object", properties: { name: { $ref: "#/$defs/Name", maxLength: 3 } },
    $defs: { Name: { type: "string" } },
  }), /Unsupported Codex \$ref siblings: maxLength/);
});

test("unsupported path regexes are omitted only from the provider schema", () => {
  const original = SLICES.foundation.loadSchema();
  const converted = toCodexSchema(original);
  const canonicalPath = original.$defs.ComponentRecord.properties.paths.items;
  const providerPath = converted.definitions.ComponentRecord.properties.paths.items;
  assert.match(canonicalPath.pattern, /\(\?!/);
  assert.equal(providerPath.pattern, undefined);
  assert.equal(providerPath.minLength, canonicalPath.minLength);
  const validatePath = new Ajv().compile(canonicalPath);
  assert.equal(validatePath("src/main.ts"), true);
  for (const value of ["../secret", "/etc/passwd", "C:\\secrets", "src/../../secret"]) {
    assert.equal(validatePath(value), false, value);
  }
  assert.equal(converted.definitions.ComponentRecord.properties.id.pattern,
    original.$defs.ComponentRecord.properties.id.pattern);
});
