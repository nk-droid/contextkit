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
import {
  PROMPT_SET_VERSION as KIT_VERSION, checkPaths, defineSlice, validateSliceResult,
} from "./slice-kit.mjs";

export const SLICE_ID = "foundation";
export const PROMPT_SET_VERSION = KIT_VERSION;

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
  const { system, slice } = foundation.loadPrompts();
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
 * Validate a foundation result.
 *
 * Delegates to the shared validator. Foundation once had its own because it runs before
 * any registry exists - but the shared validator already skips reference resolution when
 * there is no registry, and keeping a second copy was how the two drifted apart in the
 * first place. Its one distinct rule, that components own real paths, lives in `checks`.
 */
export function validateFoundation(result, snapshot, store) {
  return validateSliceResult(result, foundation, { snapshot, store, registry: null });
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


/**
 * The slice definition, so the runner can treat foundation like any other slice.
 *
 * Foundation keeps its own validator rather than using the kit's generic one: it runs
 * before any registry exists, so the reference rules the kit applies have nothing to
 * resolve against, and its component-path rule has no equivalent elsewhere.
 */
export const foundation = defineSlice({
  id: SLICE_ID,
  order: 1,
  dependsOn: [],
  title: "Foundation",
  schemaFile: "foundation.schema.json",
  promptFile: "foundation.md",
  entityPrefixes: ["component", "external", "user", "capability", "nongoal", "style", "role"],
  entityArrays: ["components", "externalSystems", "primaryUsers", "capabilities",
    "nonGoals", "repositoryRoles", "styles"],
  buildBriefing: (store) => buildBriefing(store),
  checks(result, { store }) {
    const errors = [];
    for (const component of result.components ?? []) {
      errors.push(...checkPaths(component.paths, store, { pointer: `component ${component.id}` }));
      if (!component.paths?.length) {
        errors.push({
          code: "component-without-paths",
          message: `component ${component.id} owns no paths`, id: component.id,
        });
      }
    }
    return errors;
  },
});

export const loadSchema = () => foundation.loadSchema();
export const loadPrompts = () => foundation.loadPrompts();
