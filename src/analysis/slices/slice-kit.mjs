/**
 * Shared slice runtime.
 *
 * Every slice answers a different question, and every slice is bound by the same rules:
 * do not rewrite a measurement, ground observed claims in real evidence, mint only the
 * ids you are allowed to mint, and reference earlier entities rather than reinventing
 * them. Those rules are written once here.
 *
 * The alternative - a validator per slice - looks harmless at two slices and is a
 * liability at five: the rules drift apart, and the drift shows up as a claim that
 * passes in one slice and is rejected in another for no reason a reader can see.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ID_PATTERN } from "../stable-ids.mjs";
import { validateAnnotations } from "../merge/protected-fields.mjs";
import { deriveSliceSchema } from "./derive-schema.mjs";
import { ownedBy } from "./ownership.mjs";
import { validateSchema, schemaHash } from "../validation/schema.mjs";
import { normalizeSliceIds } from "./normalize-ids.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/**
 * Version of the shared prompt contract (common-system.md) that every slice inherits.
 * Distinct from a slice's own contract version: changing how grounding is explained to
 * every slice is not the same event as changing one slice's output shape.
 */
export const PROMPT_SET_VERSION = "1.0.0";

/**
 * Keys that carry a reference to a semantic entity.
 *
 * A convention rather than a per-slice declaration: slices gain fields over time, and a
 * list that must be updated by hand is a list that silently stops covering things. Any
 * field ending in Id or Ids whose prefix names an entity kind is treated as a reference
 * and must resolve.
 */
const REFERENCE_KEY = /^(component|externalSystem|external|flow|boundary|interface|store|entity|risk|command|claim|source|target|actor|producerEntity|consumerEntity|accessEntity|affectedEntity|usedByEntity|deployedEntity|relatedEntity)Ids?$/;

export function defineSlice(spec) {
  const required = ["id", "order", "schemaFile", "promptFile", "buildBriefing"];
  for (const key of required) {
    if (!spec[key]) throw new Error(`slice definition is missing ${key}`);
  }
  return {
    dependsOn: [],
    entityPrefixes: [],
    checks: () => [],
    promptSetVersion: PROMPT_SET_VERSION,
    // Each slice versions its own output shape. A global version would mean renaming a
    // field in one slice invalidates every other slice's stored results, whose contracts
    // never moved - which is how an unrelated result gets thrown away.
    contractVersion: "2.0.0",
    ...spec,
    /**
     * Cut from the final contract rather than read from a hand-written file, so a slice
     * and the document it feeds cannot describe the same record differently.
     */
    loadSchema() {
      return deriveSliceSchema({
        title: `${spec.title} slice result`,
        description: spec.schemaDescription ?? `Interpretation only. Scanner-measured values are protected and must be absent.`,
        owns: ownedBy(spec.id),
      });
    },
    schemaHash() { return schemaHash(this.loadSchema()); },
    loadPrompts() {
      const read = (p) => fs.readFileSync(path.join(ROOT, "prompts/analysis", p), "utf8");
      return { system: read("common-system.md"), slice: read(spec.promptFile) };
    },
  };
}

/**
 * Assemble the prompt: shared contract, slice instructions, id rules, curated briefing.
 *
 * The id-namespace rule is generated from the slice definition rather than written into
 * the prompt by hand. The validator enforces `entityPrefixes`; if the prompt restated
 * them separately the two would eventually disagree, and the model would be rejected for
 * following its instructions - which has happened here more than once.
 */
export function buildSlicePrompt(slice, store, context = {}) {
  const { system, slice: instructions } = slice.loadPrompts();
  const briefing = slice.buildBriefing(store, context);
  const idRule = slice.entityPrefixes.length
    ? [
      "",
      "## Ids you create",
      "",
      `Every new id in this slice must begin with one of: ${slice.entityPrefixes.map((p) => `\`${p}.\``).join(", ")}`,
      "followed by a short kebab-case name - for example "
        + `\`${slice.entityPrefixes[0]}.payment-gateway\`.`,
      "",
      "The prefix records which slice minted the id, so an id that does not carry one is",
      "rejected. Ids frozen by an earlier slice keep the prefix they already have.",
    ].join("\n")
    : "";

  return {
    systemPrompt: system,
    briefing,
    prompt: [
      instructions,
      idRule,
      "",
      "## Briefing",
      "",
      "Curated from the static artifact and any earlier slice you depend on. Everything",
      "here is already established; use the tools for anything it does not cover.",
      "",
      "```json",
      JSON.stringify(briefing, null, 2),
      "```",
    ].join("\n"),
  };
}

/** Every entity reference in a result, as [pointer, id] pairs. */
export function collectReferences(node, pointer = "", found = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectReferences(v, `${pointer}[${i}]`, found));
    return found;
  }
  if (!node || typeof node !== "object") return found;
  for (const [key, value] of Object.entries(node)) {
    const next = pointer ? `${pointer}.${key}` : key;
    if (REFERENCE_KEY.test(key)) {
      for (const id of Array.isArray(value) ? value : [value]) {
        if (typeof id === "string") found.push([next, id]);
      }
    } else {
      collectReferences(value, next, found);
    }
  }
  return found;
}

/**
 * Every grounded claim in a result, with its pointer.
 *
 * The final contract nests grounding in its own object rather than spreading `basis` and
 * `evidenceIds` across each record, so that is where this looks. A loose `basis` is still
 * recognized, because annotations carry one directly.
 */
function claimsIn(node, pointer = "", found = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => claimsIn(v, `${pointer}[${i}]`, found));
    return found;
  }
  if (!node || typeof node !== "object") return found;
  if (node.grounding && typeof node.grounding === "object") {
    found.push([`${pointer || "(root)"}.grounding`, node.grounding]);
  } else if (typeof node.basis === "string") {
    found.push([pointer || "(root)", node]);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "annotations") continue; // handled by the shared annotation validator
    claimsIn(value, pointer ? `${pointer}.${key}` : key, found);
  }
  return found;
}

/**
 * Validate a slice result against the run and the frozen registry.
 *
 * @param {object} result the model's structured output
 * @param {object} slice  a definition from defineSlice
 * @param {{snapshot: object, store: object, registry?: object}} ctx
 */
export function validateSliceResult(result, slice, ctx) {
  const { snapshot, store, registry = null } = ctx;
  const normalized = normalizeSliceIds(result, slice, store);
  result = normalized.result;
  const errors = [];
  const add = (code, message, detail = {}) => errors.push({ code, message, ...detail });

  if (!result || typeof result !== "object") {
    return { valid: false, errors: [{ code: "not-an-object", message: "result must be an object" }] };
  }

  const structural = validateSchema(result, slice.loadSchema());
  errors.push(...structural);
  // Avoid walking malformed arrays/records. Semantic checks still run for objects
  // whose only errors are missing fields, so diagnostics remain useful.
  if (structural.some((e) => e.details.type || e.details.additionalProperty)) {
    return { valid: false, errors };
  }

  // 1. Shared rules: protected fields, grounding, prose hygiene, annotation targets.
  const entities = collectEntities(result, slice);
  const shared = validateAnnotations({
    sliceId: slice.id,
    artifactId: snapshot.artifactId,
    treeFingerprint: snapshot.treeFingerprint,
    annotations: result.annotations ?? [],
    entities,
  }, snapshot);
  errors.push(...shared.violations);

  // 2. New ids: well formed, unique, in this slice's allowed namespaces, never shadowing
  //    a static record or an entity an earlier slice froze.
  const seen = new Set();
  const frozen = new Set(registry?.entityIds ?? []);
  for (const entity of entities) {
    const id = entity.id;
    if (typeof id !== "string" || !ID_PATTERN.test(id)) {
      add("bad-entity-id", `${id} is not a valid identifier`, { id });
      continue;
    }
    if (slice.entityPrefixes.length
      && !slice.entityPrefixes.some((p) => id.startsWith(`${p}.`))) {
      add("entity-outside-namespace",
        `${slice.id} may only mint ids prefixed ${slice.entityPrefixes.join(", ")}`, { id });
    }
    if (seen.has(id)) add("duplicate-entity-id", `${id} is declared twice`, { id });
    seen.add(id);
    if (frozen.has(id)) {
      add("entity-id-frozen", `${id} was already frozen by an earlier slice; reference it instead`, { id });
    }
  }

  // 3. References resolve through the frozen registry, not by reinvention.
  if (registry) {
    const known = new Set([...frozen, ...seen]);
    for (const [pointer, id] of collectReferences(result)) {
      if (!known.has(id) && !snapshot.records.has(id) && !store.recordsById.has(id) && !snapshot.evidenceIds.has(id)) {
        add("unresolved-reference", `${pointer} references ${id}, which is in no registry`,
          { pointer, id });
      }
    }
  }

  // 4. Grounding, on every claim the slice produced.
  for (const [pointer, claim] of claimsIn(result)) {
    if (!["observed", "documented", "inferred"].includes(claim.basis)) {
      add("bad-basis", `${pointer} has basis ${claim.basis}`, { pointer, basis: claim.basis });
      continue;
    }
    if (claim.basis === "observed" && !(claim.evidenceIds ?? []).length) {
      add("observed-without-evidence", `${pointer} claims observed basis with no evidence`, { pointer });
    }
    for (const id of claim.evidenceIds ?? []) {
      if (!snapshot.evidenceIds.has(id)) {
        add("unresolved-evidence", `${pointer} cites evidence ${id}, which is not in this run`,
          { pointer, evidenceId: id });
      }
    }
    if (claim.verificationStatus && claim.verificationStatus !== "not-checked") {
      add("premature-verification", `${pointer} claims verification before the verification pass`, { pointer });
    }
  }

  // 5. Whatever is specific to this slice.
  errors.push(...(slice.checks(result, { ...ctx, entities }) ?? []));

  return { valid: errors.length === 0, errors, idMappings: normalized.mappings };
}

/** Entities a slice declares, from the arrays its definition names. */
export function collectEntities(result, slice) {
  const out = [];
  for (const key of slice.entityArrays ?? []) {
    // Some owned arrays (e.g. repositoryRoles) are strings, not entities.
    for (const entity of result[key] ?? []) {
      if (entity && typeof entity === "object" && !Array.isArray(entity)) out.push(entity);
    }
  }
  return out;
}

/** Paths a slice claims must exist in the inventory. */
export function checkPaths(paths, store, { pointer, allowPrefix = true }) {
  const errors = [];
  for (const p of paths ?? []) {
    const known = p === "." || store.filesByPath.has(p)
      || (allowPrefix && [...store.filesByPath.keys()].some(
        (f) => f.startsWith(`${String(p).replace(/\/$/, "")}/`)));
    if (!known) {
      errors.push({ code: "unknown-path", message: `${pointer} claims ${p}, which is not in the inventory`, path: p });
    }
  }
  return errors;
}
