import Ajv from "ajv";
import { createHash } from "node:crypto";
import { toClaudeSchema } from "../../../scripts/claude-schema.mjs";

// Pydantic emits descriptive keywords and formats. Validate structural constraints
// here; repository paths, grounding and referential integrity have separate checks.
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const validators = new Map();

export function schemaHash(schema) {
  return createHash("sha256").update(JSON.stringify(schema)).digest("hex");
}

export function validateSchema(value, schema) {
  const hash = schemaHash(schema);
  if (!validators.has(hash)) validators.set(hash, ajv.compile(toClaudeSchema(schema)));
  const validate = validators.get(hash);
  validate(value);
  return (validate.errors ?? []).map((e) => ({
    code: "schema-invalid", pointer: e.instancePath,
    message: `${e.instancePath || "result"} ${e.message}`,
    details: e.params,
  }));
}
