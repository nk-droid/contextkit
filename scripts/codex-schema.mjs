import { toClaudeSchema } from "./claude-schema.mjs";

/** Codex structured output requires closed objects and every property required.
 * Annotation dictionaries use a key/value list on the wire, then are decoded.
 * https://developers.openai.com/api/docs/guides/structured-outputs
 */
export function toCodexSchema(schema) {
  const converted = toClaudeSchema(schema);
  const fields = converted.properties?.annotations?.items?.properties?.fields;
  if (fields?.additionalProperties && typeof fields.additionalProperties === "object") {
    converted.properties.annotations.items.properties.fields = {
      type: "array", description: "Semantic annotation fields as key/value entries. Omit fields you cannot establish.",
      items: { type: "object", additionalProperties: false, required: ["key", "value"], properties: {
        key: { type: "string" }, value: fields.additionalProperties,
      } },
    };
  }
  function visit(value) {
    if (!value || typeof value !== "object") return;
    delete value["x-target"];
    if (typeof value.$ref === "string") {
      // Codex's response schema validator requires a bare reference. These are
      // annotations only; the referenced definition retains every value constraint.
      delete value.description;
      delete value.title;
      const siblings = Object.keys(value).filter((key) => key !== "$ref");
      if (siblings.length) throw new Error(`Unsupported Codex $ref siblings: ${siblings.join(", ")}`);
    }
    // The response-format regex engine has no lookaround support. Keep the
    // canonical path constraint in local validation, outside the provider schema.
    if (typeof value.pattern === "string" && /\(\?(?:[=!]|<[=!])/.test(value.pattern)) {
      delete value.pattern;
    }
    if (value.type === "object") {
      if (value.additionalProperties && value.additionalProperties !== false) throw new Error("Unsupported open object in Codex output schema");
      value.additionalProperties = false;
      value.required = Object.keys(value.properties ?? {});
    }
    Object.values(value).forEach(visit);
  }
  visit(converted);
  return converted;
}

export function decodeCodexResult(result) {
  for (const annotation of result?.annotations ?? []) {
    if (!Array.isArray(annotation.fields)) continue;
    const keys = annotation.fields.map((field) => field.key);
    if (new Set(keys).size !== keys.length) throw new Error("Duplicate annotation field in Codex response");
    annotation.fields = Object.fromEntries(annotation.fields.map(({ key, value }) => [key, value]));
  }
  return result;
}
