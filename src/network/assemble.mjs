import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RunStore } from "../analysis/mcp/run-store.mjs";
import { buildProtectedSnapshot, mergeAnnotations } from "../analysis/merge/protected-fields.mjs";
import { SLICES } from "../analysis/slices/plan-slices.mjs";
import { checkCachedSlice, readFoundation } from "../analysis/slices/cache.mjs";
import { validateStaticDocument } from "../analysis/validation/validate-static.mjs";
import { slug, shortHash } from "../analysis/stable-ids.mjs";
import { parseNetworkFacts } from "./schema.mjs";
import { normalizeSliceIds } from "../analysis/slices/normalize-ids.mjs";
import { collectEntities } from "../analysis/slices/slice-kit.mjs";

const owns = (prefix, file) => prefix === "." || file === prefix || file.startsWith(`${prefix.replace(/\/+$/, "")}/`);
const grounding = (evidenceIds, basis = "observed", confidence = "high") => ({ basis, confidence, evidenceIds });

/** Longest matching path wins only when there is one owner at that specificity. */
export function ownerFor(file, components) {
  const matches = components.flatMap((c) => c.paths.filter((p) => owns(p, file)).map((p) => ({ id: c.id, length: p === "." ? 0 : p.length })));
  const best = Math.max(-1, ...matches.map((m) => m.length));
  const ids = [...new Set(matches.filter((m) => m.length === best).map((m) => m.id))];
  return ids.length === 1 ? ids[0] : null;
}

function directoryComponents(doc) {
  let groups = [...new Set(doc.inventory.files.map((f) => {
    const parts = f.path.split("/");
    if (parts.length === 1) return ".";
    return /^(src|apps|packages|lib)$/.test(parts[0]) && parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0];
  }))].sort();
  if (groups.length > 80) groups = [...new Set(doc.inventory.files.map((f) => f.path.includes("/") ? f.path.split("/")[0] : "."))].sort();
  if (groups.length > 80) groups = ["."];
  if (!groups.length) groups = ["."];
  return groups.map((p) => ({
    id: `component.directory.${slug(p === "." ? "root" : p).slice(0, 95)}.${shortHash(p, 8)}`,
    name: p === "." ? doc.repository.name : p,
    kind: "directory", lifecycle: "unknown", paths: [p], publicInterfaceIds: [],
    summary: `Directory grouping for ${p === "." ? "repository root" : p}; architectural responsibility has not been analyzed.`,
    responsibilities: [],
    grounding: grounding(doc.evidence.filter((e) => owns(p, e.path)).slice(0, 3).map((e) => e.id), "inferred", "low"),
  }));
}

export function assembleNetwork(workspace, { provider = "static", sourceIdentity = null } = {}) {
  const store = RunStore.fromDirectory(workspace.dir, { includeSourceIndex: false });
  const doc = store.document;
  const staticValidation = validateStaticDocument(doc);
  if (!staticValidation.valid) throw new Error(`Invalid static scan: ${JSON.stringify(staticValidation.errors.slice(0, 3))}`);
  if (doc.diagnostics.sourceIdentityChanged) throw new Error("Source changed during the scan; rescan before exporting");
  const snapshot = buildProtectedSnapshot(doc);
  let foundation = null;
  let behavior = null;
  const slices = [];
  let idMappings = [];
  const evidence = new Map(doc.evidence.map((e) => [e.id, e]));
  if (provider !== "static") {
    const first = readFoundation(workspace, SLICES.foundation, provider, { store, snapshot });
    foundation = first.envelope.result;
    const slice = SLICES["behavior-data"];
    const file = workspace.slicePath(slice.order, slice.id, provider, "response");
    if (!fs.existsSync(file)) throw new Error(`Missing behavior-data result; run contextkit network with --provider ${provider}`);
    const envelope = JSON.parse(fs.readFileSync(file, "utf8"));
    const check = checkCachedSlice(envelope, slice, { store, snapshot, registry: first.registry }, first);
    if (!check.valid) throw new Error(check.errors.map((e) => e.message).join("; "));
    const normalized = normalizeSliceIds(envelope.result, slice, store);
    behavior = normalized.result;
    idMappings = normalized.mappings;
    for (const result of [first.envelope, envelope]) {
      for (const record of result.mcpReport?.requestedEvidence ?? []) evidence.set(record.id, record);
    }
    slices.push({ ...foundation, sliceId: "foundation" }, { ...behavior, sliceId: "behavior-data" });
  }

  const components = (foundation?.components ?? directoryComponents(doc)).map((c) => ({ ...c, publicInterfaceIds: [...c.publicInterfaceIds] }));
  const warnings = [...doc.diagnostics.warnings, ...slices.flatMap((s) => s.warnings ?? [])];
  if (idMappings.length) warnings.push(`Assigned distinct semantic IDs to ${idMappings.length} scanner-backed records; original provider responses are retained in the run.`);
  if (!foundation) warnings.push("Static mode: components are inferred directory groups. Semantic architecture, stores, interfaces, risks and shared resources were not analyzed.");
  const { merged, conflicts } = mergeAnnotations(doc, slices, snapshot);
  for (const conflict of conflicts) {
    delete merged.get(conflict.targetId).semantic[conflict.field];
    delete merged.get(conflict.targetId).semanticProvenance[conflict.field];
    warnings.push(`Conflicting ${conflict.field} annotations for ${conflict.targetId}; omitted that annotation.`);
  }
  const componentIds = new Set(components.map((c) => c.id));
  // Semantic slices can reference more record kinds than Orb renders. Project all
  // exported reference arrays against their destination type using the validated
  // registries, and report every omission. Unknown IDs still reach validation; never
  // infer an accessor/consumer from a data entity's owning store or source path.
  const knownIds = new Set([
    ...store.recordsById.keys(),
    ...slices.flatMap((s) => collectEntities(s, SLICES[s.sliceId]).map((e) => e.id)),
  ]);
  const architectureIds = new Set([
    ...componentIds, ...(foundation?.externalSystems ?? []).map((e) => e.id),
    ...(behavior?.stores ?? []).map((s) => s.id),
  ]);
  const projectRefs = (ids, allowed, field, destination) => {
    const omitted = new Set(ids.filter((id) => !allowed.has(id) && knownIds.has(id)));
    if (omitted.size) warnings.push(`Orb omitted references outside ${destination} from ${field}: ${[...omitted].join(", ")}. Full references remain in the saved analysis.`);
    return ids.filter((id) => !omitted.has(id));
  };
  const projectArchitectureRefs = (records, fields) => records.map((record) => ({
    ...record,
    ...Object.fromEntries(fields.map((field) => [field,
      projectRefs(record[field], architectureIds, `${record.id}.${field}`, "exported architecture nodes"),
    ])),
  }));
  const surfaces = projectArchitectureRefs(behavior?.apiSurfaces ?? [], ["consumerEntityIds"]);
  const stores = projectArchitectureRefs(behavior?.stores ?? [], ["accessEntityIds"]);
  const dataContracts = projectArchitectureRefs(behavior?.dataContracts ?? [], ["producerEntityIds", "consumerEntityIds"]);
  const surfaceIds = new Set(surfaces.map((s) => s.id));
  for (const c of components) {
    c.publicInterfaceIds = projectRefs(c.publicInterfaceIds, surfaceIds, `${c.id}.publicInterfaceIds`, "exported API surfaces");
  }
  for (const surface of surfaces) {
    for (const endpoint of surface.endpoints) {
      const id = ownerFor(endpoint.implementationPath, components);
      const component = components.find((c) => c.id === id);
      if (component && !component.publicInterfaceIds.includes(surface.id)) component.publicInterfaceIds.push(surface.id);
    }
  }
  const symbols = doc.code.symbols.map((s) => {
    const enriched = merged.get(s.id);
    const annotation = enriched?.semantic ?? {};
    const fileAnnotation = merged.get(s.path)?.semantic ?? {};
    const explicit = annotation.componentId ?? fileAnnotation.componentId;
    if (explicit && !componentIds.has(explicit)) throw new Error(`Unknown component ${explicit} for ${s.id}`);
    return {
      ...s, componentId: explicit ?? ownerFor(s.path, components),
      summary: annotation.summary ?? s.docstringFirstLine ?? "",
      grounding: grounding(
        [...new Set([...s.evidenceIds, ...(enriched?.semanticProvenance?.summary?.evidenceIds ?? [])])],
        enriched?.semanticProvenance?.summary?.basis ?? "observed",
      ),
    };
  });
  const byId = new Map(symbols.map((s) => [s.id, s]));
  const calls = doc.code.calls.map((c) => {
    const a = byId.get(c.callerSymbolId)?.componentId;
    const b = byId.get(c.calleeSymbolId)?.componentId;
    return { ...c, crossesComponent: Boolean(a && b && a !== b) };
  });
  const relationships = behavior?.relationships ?? [];
  if (!behavior) {
    const pairs = new Set();
    for (const c of calls.filter((c) => c.crossesComponent)) {
      const sourceId = byId.get(c.callerSymbolId).componentId;
      const targetId = byId.get(c.calleeSymbolId).componentId;
      const key = `${sourceId} ${targetId}`;
      if (pairs.has(key)) continue;
      pairs.add(key);
      relationships.push({ sourceId, targetId, kind: "static-call", direction: "outbound", label: "calls", summary: "Extracted calls between inferred directory groups; includes heuristic call resolution." });
    }
  }
  const unowned = symbols.filter((s) => !s.componentId).length;
  if (unowned) warnings.push(`${unowned} symbols have no unambiguous component owner; their ownership remains unset.`);
  const extraction = doc.code.extraction;
  if (extraction.discoveredSymbols > symbols.length) warnings.push(`Symbol retention kept ${symbols.length} of ${extraction.discoveredSymbols} discovered symbols.`);
  if (doc.diagnostics.unresolvedCalls) warnings.push(`${doc.diagnostics.unresolvedCalls} calls could not be resolved; the call graph is partial.`);
  for (const extractor of doc.scanner.extractors.filter((e) => !e.available)) warnings.push(`${extractor.name}: extraction unavailable.`);
  const sourceFile = path.join(workspace.dir, "NETWORK_SOURCE.json");
  const recordedIdentity = fs.existsSync(sourceFile) ? JSON.parse(fs.readFileSync(sourceFile, "utf8")).identity : null;
  const identity = sourceIdentity ?? recordedIdentity ?? doc.repository.canonicalRemote ?? `scan:${doc.repository.id}:${doc.repository.treeFingerprint}`;
  const facts = parseNetworkFacts({
    schemaVersion: 1,
    artifactId: `network.${slug(doc.repository.name).slice(0, 70)}.${shortHash(JSON.stringify([doc.artifactId, slices, provider]), 16)}`,
    repository: {
      ...doc.repository,
      id: `repo.${slug(doc.repository.name).slice(0, 70)}.${shortHash(identity, 12)}`,
      displayName: doc.repository.name,
      sourceLabel: doc.repository.canonicalRemote ?? doc.repository.name,
    },
    architecture: { components, externalSystems: foundation?.externalSystems ?? [], relationships },
    code: { extraction: { performed: extraction.performed }, symbols, calls },
    interfaces: { apiSurfaces: surfaces, dataContracts },
    data: { stores },
    // These layers have no semantic producer yet. Their absence is explicit coverage,
    // never fabricated negative findings or guessed consumers of shared resources.
    dependencies: [], operations: { configurationKeys: [] }, delivery: { deploymentTargets: [] },
    security: { trustBoundaries: [], findings: [] }, quality: { risks: [] }, claims: [],
    evidence: [...evidence.values()],
    coverage: {
      mode: provider === "static" ? "static" : "semantic",
      completedSlices: slices.map((s) => s.sliceId),
      missingLayers: provider === "static" ? ["semantic-architecture", "data-flow", "risk", "shared"] : ["risk", "shared"],
      unsupportedLanguages: doc.diagnostics.unsupportedLanguages,
      unresolvedCalls: doc.diagnostics.unresolvedCalls,
      discoveredSymbols: extraction.discoveredSymbols, retainedSymbols: symbols.length,
      unownedSymbols: unowned,
    },
    warnings: [...new Set(warnings)],
  });
  const inventory = new Map(doc.inventory.files.map((f) => [f.path, f]));
  for (const e of facts.evidence) {
    const file = inventory.get(e.path);
    if (!file || (e.lineEnd && file.lineCount && e.lineEnd > file.lineCount)) throw new Error(`Invalid evidence location: ${e.id}`);
  }
  return facts;
}

/** Validate before replacing an existing export, on the same filesystem. */
export function publishNetwork(value, output) {
  const facts = parseNetworkFacts(value);
  const compact = JSON.stringify(facts);
  if (Buffer.byteLength(compact) > 1_900_000) throw new Error("Network exceeds the web database's 1.9 MB import limit; narrow the scanned repository.");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(facts, null, 2) + "\n");
    fs.renameSync(temporary, output);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return facts;
}
