/**
 * Slice schemas, derived from the final contract.
 *
 * A slice's output schema is not written by hand. It is cut out of
 * `context-facts.schema.json` - the same field names, the same required lists, the same
 * grounding object - so that assembly is a join rather than a translation.
 *
 * The first version of these slices was hand-written from the plan's prose. It produced
 * a parallel vocabulary: `terminates` where the contract says `outcome`, `fromId` where
 * it says `sourceId`, loose `basis`/`evidenceIds` where it wants a `grounding` object.
 * Thirty-six required fields in one section had no producer at all, and no assembler
 * could have invented them. Deriving removes that whole class of drift: if the contract
 * gains a field, the slice that owns it is asked for it on the next run.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./slice-kit.mjs";

let cached = null;

export function loadFinalSchema() {
  cached ??= JSON.parse(fs.readFileSync(path.join(ROOT, "schemas/context-facts.schema.json"), "utf8"));
  return cached;
}

const defsOf = (schema) => schema.$defs ?? schema.definitions ?? {};

/** Resolve a local $ref one level. */
function deref(node, schema) {
  if (node && typeof node === "object" && typeof node.$ref === "string") {
    const name = node.$ref.split("/").pop();
    return defsOf(schema)[name] ?? {};
  }
  return node;
}

/** Every definition name a subtree references, transitively. */
function referencedDefs(node, schema, found = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) referencedDefs(item, schema, found);
    return found;
  }
  if (!node || typeof node !== "object") return found;
  if (typeof node.$ref === "string") {
    const name = node.$ref.split("/").pop();
    if (!found.has(name)) {
      found.add(name);
      referencedDefs(defsOf(schema)[name] ?? {}, schema, found);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref") continue;
    referencedDefs(value, schema, found);
  }
  return found;
}

/**
 * Cut a slice schema out of the final contract.
 *
 * @param {{title: string, description: string,
 *          owns: Array<{section: string, array: string, as?: string, description?: string}>}} spec
 */
export function deriveSliceSchema(spec) {
  const finalSchema = loadFinalSchema();
  const properties = {};
  const required = [];
  const needed = new Set();

  for (const { section, array, as, description } of spec.owns) {
    const sectionSchema = deref(finalSchema.properties[section], finalSchema);
    if (!sectionSchema?.properties?.[array]) {
      throw new Error(`the final schema has no ${section}.${array}`);
    }
    const arraySchema = deref(sectionSchema.properties[array], finalSchema);
    const name = as ?? array;

    properties[name] = {
      ...arraySchema,
      ...(description ? { description } : {}),
      // Where this lands in the final document, so the assembler needs no lookup table
      // and a reader can see the mapping without one either.
      "x-target": `${section}.${array}`,
    };
    required.push(name);
    referencedDefs(arraySchema, finalSchema, needed);
  }

  // Annotations are a slice concern, not a final-document section: they are joined onto
  // static records during assembly and never appear under their own key.
  properties.annotations = ANNOTATIONS;
  properties.warnings = WARNINGS;
  properties.unknowns = UNKNOWNS;

  const $defs = {};
  for (const name of [...needed].sort()) $defs[name] = defsOf(finalSchema)[name];

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: spec.title,
    description: spec.description,
    type: "object",
    additionalProperties: false,
    required,
    properties,
    ...(Object.keys($defs).length ? { $defs } : {}),
  };
}

const ANNOTATIONS = {
  type: "array",
  description: "Enrichment joined onto existing static records by id. Fields carry meaning "
    + "only; setting a scanner-measured value is rejected.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["targetId", "basis", "fields"],
    properties: {
      targetId: { type: "string", description: "A file path, symbol id, or detection id from this run." },
      basis: { type: "string", enum: ["observed", "documented", "inferred"] },
      evidenceIds: { type: "array", items: { type: "string" } },
      fields: {
        type: "object",
        additionalProperties: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
            { type: "null" },
          ],
        },
      },
    },
  },
};

const WARNINGS = {
  type: "array",
  items: { type: "string" },
  description: "Anything that looked wrong or contradictory while reading.",
};

const UNKNOWNS = {
  type: "array",
  description: "Questions the available facts could not answer. Prefer an unknown to a guess.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["question", "whyUnresolved"],
    properties: {
      question: { type: "string" },
      whyUnresolved: { type: "string" },
    },
  },
};

/** Where each slice's output lands in the final document, for the assembler. */
export function targetsOf(sliceSchema) {
  return Object.entries(sliceSchema.properties)
    .filter(([, value]) => value["x-target"])
    .map(([key, value]) => ({ from: key, to: value["x-target"] }));
}
