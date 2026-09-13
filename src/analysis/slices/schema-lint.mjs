/**
 * Slice-schema lint for provider structured output.
 *
 * Provider CLIs compile a response schema with a strict JSON Schema validator, and a
 * schema they reject fails the whole call - after the prompt has been sent and paid for.
 * The feedback arrives as one line on stderr, minutes in, with no indication which of
 * several schemas was at fault.
 *
 * So the constraints are checked here instead, offline and in the test suite. These are
 * not general JSON Schema rules; they are the specific things a strict compiler refuses,
 * each one learned from a rejection.
 */

/** Walk every subschema, yielding [pointer, schema]. */
function* subschemas(schema, pointer = "#") {
  if (!schema || typeof schema !== "object") return;
  yield [pointer, schema];
  for (const key of ["properties", "$defs", "definitions", "patternProperties"]) {
    for (const [name, value] of Object.entries(schema[key] ?? {})) {
      yield* subschemas(value, `${pointer}/${key}/${name}`);
    }
  }
  for (const key of ["items", "additionalProperties", "contains", "not", "if", "then", "else"]) {
    if (schema[key] && typeof schema[key] === "object") {
      yield* subschemas(schema[key], `${pointer}/${key}`);
    }
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    for (const [i, value] of (schema[key] ?? []).entries()) {
      yield* subschemas(value, `${pointer}/${key}/${i}`);
    }
  }
}

export function lintProviderSchema(schema) {
  const problems = [];
  const add = (rule, pointer, message) => problems.push({ rule, pointer, message });

  for (const [pointer, node] of subschemas(schema)) {
    // strictTypes: a union type needs allowUnionTypes, which providers do not enable.
    // Write it as anyOf instead - same meaning, accepted everywhere.
    if (Array.isArray(node.type)) {
      add("union-type", pointer,
        `type is a union [${node.type.join(", ")}]; use anyOf with one type each`);
    }

    // strictRequired: requiring a property that is not described is almost always a typo,
    // and a strict compiler treats it as one.
    if (Array.isArray(node.required) && node.properties) {
      for (const name of node.required) {
        if (!Object.hasOwn(node.properties, name)) {
          add("required-undescribed", pointer, `required names ${name}, which has no schema`);
        }
      }
    }

    // A const/enum that contradicts its own type is accepted by lax validators and
    // rejected by strict ones.
    if (node.enum && node.type === "object") {
      add("enum-on-object", pointer, "enum on an object type is rejected as contradictory");
    }
  }

  // $defs is 2019-09 and later; under a draft-07 $schema a strict compiler treats it as
  // an unknown keyword. Normalization rewrites it, so this only catches an un-normalized
  // schema on its way to a provider.
  const draft07 = typeof schema.$schema === "string" && schema.$schema.includes("draft-07");
  if (draft07 && schema.$defs) {
    add("defs-under-draft-07", "#", "$defs with a draft-07 $schema; use definitions");
  }

  // Every local $ref must resolve, or compilation fails with a missing-reference error.
  const roots = new Set(Object.keys(schema.$defs ?? {}).map((k) => `#/$defs/${k}`));
  for (const k of Object.keys(schema.definitions ?? {})) roots.add(`#/definitions/${k}`);
  for (const [pointer, node] of subschemas(schema)) {
    if (typeof node.$ref === "string" && node.$ref.startsWith("#") && !roots.has(node.$ref)) {
      add("dangling-ref", pointer, `$ref ${node.$ref} does not resolve`);
    }
  }

  return { ok: problems.length === 0, problems };
}
