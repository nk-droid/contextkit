/**
 * Slice 1: foundation (plan §14.1).
 *
 * Establishes the project profile, components, external systems, and the first
 * annotations. The component and external-system ids it creates become the entity
 * registry every later slice references, so this is the one slice whose output is
 * frozen rather than merely validated.
 *
 * The slice supplies a briefing rather than making the model discover the basics
 * through tool calls. A model that has to search for the file count spends its first
 * several turns rebuilding what the scanner already knows, and arrives at the actual
 * question with less budget and no better information.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateAnnotations } from "../merge/protected-fields.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export const SLICE_ID = "foundation";
export const PROMPT_SET_VERSION = "1.0.0";

export function loadSchema() {
  return JSON.parse(fs.readFileSync(
    path.join(ROOT, "schemas/analysis-slices/foundation.schema.json"), "utf8"));
}

export function loadPrompts() {
  const read = (p) => fs.readFileSync(path.join(ROOT, "prompts/analysis", p), "utf8");
  return { system: read("common-system.md"), slice: read("foundation.md") };
}

/** Directory rollup, so the model sees shape without paging the whole inventory. */
function directoryMap(files, limit = 40) {
  const counts = new Map();
  for (const file of files) {
    const top = file.path.includes("/") ? file.path.split("/").slice(0, 2).join("/") : ".";
    const entry = counts.get(top) ?? { path: top, files: 0, bytes: 0, languages: new Set() };
    entry.files += 1;
    entry.bytes += file.bytes ?? 0;
    if (file.language) entry.languages.add(file.language);
    counts.set(top, entry);
  }
  return [...counts.values()]
    .sort((a, b) => b.files - a.files)
    .slice(0, limit)
    .map((e) => ({ path: e.path, files: e.files, languages: [...e.languages].sort() }));
}

/**
 * Symbols worth naming up front: entrypoints first, then the most connected.
 *
 * Degree is a better proxy for importance than size or position - a function twenty
 * other functions call is load-bearing whatever its length.
 */
function keySymbols(document, limit = 40) {
  const degree = new Map();
  for (const call of document.code.calls) {
    degree.set(call.callerSymbolId, (degree.get(call.callerSymbolId) ?? 0) + 1);
    degree.set(call.calleeSymbolId, (degree.get(call.calleeSymbolId) ?? 0) + 1);
  }
  return [...document.code.symbols]
    .map((s) => ({ symbol: s, score: (s.isEntrypoint ? 1000 : 0) + (degree.get(s.id) ?? 0) }))
    .sort((a, b) => b.score - a.score || (a.symbol.id < b.symbol.id ? -1 : 1))
    .slice(0, limit)
    .map(({ symbol, score }) => ({
      id: symbol.id, name: symbol.name, kind: symbol.kind, path: symbol.path,
      exported: symbol.exported, isEntrypoint: symbol.isEntrypoint, connections: score % 1000,
    }));
}

/** The curated inputs plan §14.1 names, small enough to sit in a prompt. */
export function buildBriefing(store) {
  const doc = store.document;
  const detections = doc.detections;
  const take = (kind, n, map) => (detections[kind] ?? []).slice(0, n).map(map);

  return {
    runId: store.runId,
    repository: {
      name: doc.repository.name,
      revision: doc.repository.revision,
      defaultBranch: doc.repository.defaultBranch,
    },
    coverage: {
      files: doc.inventory.files.length,
      languages: doc.inventory.languages,
      symbolsRetained: doc.code.symbols.length,
      callEdges: doc.code.calls.length,
      unresolvedCalls: doc.diagnostics?.unresolvedCalls ?? null,
      unsupportedLanguages: doc.diagnostics?.unsupportedLanguages ?? [],
      note: "An absent detection means the scanner did not find one, not that none exists.",
    },
    directories: directoryMap(doc.inventory.files),
    manifests: (doc.inventory.manifests ?? []).map(
      (m) => ({ path: m.path, kind: m.kind, packageName: m.packageName })),
    technologies: take("technologies", 30, (t) => ({ id: t.id, name: t.name, category: t.category })),
    dependencies: take("dependencies", 40,
      (d) => ({ id: d.id, name: d.name, ecosystem: d.ecosystem, kind: d.kind, direct: d.direct })),
    entrypoints: take("entrypoints", 20, (e) => ({ id: e.id, name: e.name, path: e.path })),
    routes: take("routes", 25,
      (r) => ({ id: r.id, method: r.method, path: r.pathOrName, framework: r.framework })),
    dataStores: take("dataStores", 10, (s) => ({ id: s.id, name: s.name, kind: s.kind })),
    commands: take("commands", 20, (c) => ({ id: c.id, name: c.name, category: c.category })),
    keySymbols: keySymbols(doc),
    evidenceAvailable: doc.evidence.length,
  };
}

export function buildPrompt(store) {
  const { system, slice } = loadPrompts();
  const briefing = buildBriefing(store);
  return {
    systemPrompt: system,
    prompt: [
      slice,
      "",
      "## Briefing",
      "",
      "Curated from the static artifact. Everything here is already established; use the",
      "tools for anything it does not cover.",
      "",
      "```json",
      JSON.stringify(briefing, null, 2),
      "```",
    ].join("\n"),
    briefing,
  };
}

/**
 * Validate a foundation result against the run.
 *
 * Layered on purpose: shape first, then the protected-field and grounding rules shared
 * with the assembler, then the rules specific to this slice. A caller gets every
 * violation at once rather than one per round trip.
 */
export function validateFoundation(result, snapshot, store) {
  const errors = [];
  const add = (code, message, detail = {}) => errors.push({ code, message, ...detail });

  if (!result || typeof result !== "object") {
    return { valid: false, errors: [{ code: "not-an-object", message: "result must be an object" }] };
  }
  for (const key of ["project", "components", "externalSystems", "annotations"]) {
    if (!(key in result)) add("missing-section", `result is missing ${key}`, { key });
  }

  const components = result.components ?? [];
  const externals = result.externalSystems ?? [];

  // Shared rules: protected fields, grounding, reference resolution, prose hygiene.
  //
  // The run binding is supplied from the snapshot rather than read off the result: the
  // model cannot emit an artifact id (the schema has no field for one), so asking it to
  // match here would compare the snapshot against itself and always pass. Binding is a
  // property of the stored response, and checkRunBinding is where it is enforced.
  const shared = validateAnnotations({
    sliceId: SLICE_ID,
    artifactId: snapshot.artifactId,
    treeFingerprint: snapshot.treeFingerprint,
    annotations: result.annotations ?? [],
    entities: [...components, ...externals],
  }, snapshot);
  errors.push(...shared.violations);

  // Ids must be unique within the slice as well as new to the run.
  const seen = new Set();
  for (const entity of [...components, ...externals]) {
    if (seen.has(entity.id)) add("duplicate-entity-id", `${entity.id} is declared twice`, { id: entity.id });
    seen.add(entity.id);
  }

  // Component paths are claims about the repository and must resolve to real files.
  for (const component of components) {
    for (const p of component.paths ?? []) {
      const known = store.filesByPath.has(p)
        || [...store.filesByPath.keys()].some((f) => f.startsWith(`${p.replace(/\/$/, "")}/`));
      if (!known) {
        add("unknown-path", `component ${component.id} claims ${p}, which is not in the inventory`,
          { id: component.id, path: p });
      }
    }
    if (!component.paths?.length) {
      add("component-without-paths", `component ${component.id} owns no paths`, { id: component.id });
    }
  }

  for (const record of [result.project, ...components, ...externals].filter(Boolean)) {
    if (record.basis === "observed" && !(record.evidenceIds ?? []).length) {
      add("observed-without-evidence", "an observed claim carries no evidence", { id: record.id ?? "project" });
    }
    for (const id of record.evidenceIds ?? []) {
      if (!snapshot.evidenceIds.has(id)) {
        add("unresolved-evidence", `evidence ${id} is not in this run`, { id: record.id ?? "project", evidenceId: id });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Check that a stored slice response belongs to the run it is about to be used with.
 *
 * Responses outlive the process that produced them - they sit in the run directory and
 * may be read back days later, by a tool that was pointed at a different scan. The ids
 * inside would still look valid, because id shapes do not change between runs, and the
 * result would be annotations attached to the wrong code. So provenance is recorded when
 * the response is written and checked whenever it is read.
 */
export function checkRunBinding(responseEnvelope, snapshot) {
  const errors = [];
  const claimedArtifact = responseEnvelope?.boundTo?.artifactId ?? null;
  const claimedFingerprint = responseEnvelope?.boundTo?.treeFingerprint ?? null;

  if (!claimedArtifact || !claimedFingerprint) {
    errors.push({
      code: "unbound-response",
      message: "this response does not record which run it was produced against",
    });
    return { valid: false, errors };
  }
  if (claimedArtifact !== snapshot.artifactId) {
    errors.push({
      code: "artifact-mismatch",
      message: "response was produced against a different static artifact",
      expected: snapshot.artifactId, received: claimedArtifact,
    });
  }
  if (claimedFingerprint !== snapshot.treeFingerprint) {
    errors.push({
      code: "fingerprint-mismatch",
      message: "response was produced against a different repository tree",
      expected: snapshot.treeFingerprint, received: claimedFingerprint,
    });
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Freeze the entity registry (plan §14.1).
 *
 * Later slices may reference these ids and may not invent siblings for them, so the
 * registry is written once and read thereafter. Freezing is what makes "the same
 * component" mean the same thing in slice 4 as it did here.
 */
export function freezeEntityRegistry(result, { snapshot }) {
  const entities = [
    ...(result.components ?? []).map((c) => ({
      id: c.id, kind: "component", name: c.name, paths: c.paths ?? [],
    })),
    ...(result.externalSystems ?? []).map((e) => ({
      id: e.id, kind: "external-system", name: e.name,
    })),
  ].sort((a, b) => (a.id < b.id ? -1 : 1));

  return {
    frozenAt: new Date().toISOString(),
    sliceId: SLICE_ID,
    artifactId: snapshot.artifactId,
    treeFingerprint: snapshot.treeFingerprint,
    entities,
    entityIds: entities.map((e) => e.id),
  };
}

/** Check a later slice's references against the frozen registry. */
export function checkAgainstRegistry(registry, referencedIds) {
  const known = new Set(registry.entityIds);
  return [...new Set(referencedIds)].filter((id) => !known.has(id));
}
