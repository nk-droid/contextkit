#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function toClaudeSchema(schema) {
  const converted = JSON.parse(JSON.stringify(schema));
  delete converted.$schema;
  delete converted.$id;

  if (converted.$defs) {
    converted.definitions = converted.$defs;
    delete converted.$defs;
  }

  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string") {
      value.$ref = value.$ref.replace(/^#\/\$defs\//, "#/definitions/");
    }
    Object.values(value).forEach(visit);
  };

  visit(converted);
  return converted;
}

function main() {
  const schemaFile = process.argv[2];
  if (!schemaFile) {
    console.error("Usage: node scripts/claude-schema.mjs <schema.json>");
    process.exitCode = 2;
    return;
  }
  const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
  process.stdout.write(JSON.stringify(toClaudeSchema(schema)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
