/**
 * Slice 2: behavior and data (plan §14.2).
 *
 * Depends on the frozen entity registry: components are referenced, never re-declared.
 * The briefing therefore leads with that registry, so the model sees the vocabulary it
 * must use before it sees anything it might be tempted to name itself.
 */
import { checkPaths, defineSlice } from "./slice-kit.mjs";

/** Call neighbourhoods around entrypoints - where flows begin. */
function entrypointNeighbourhoods(store, limit = 12) {
  const doc = store.document;
  const byId = new Map(doc.code.symbols.map((s) => [s.id, s]));
  const entrySymbols = doc.code.symbols.filter((s) => s.isEntrypoint).slice(0, limit);

  return entrySymbols.map((symbol) => {
    const reaches = [];
    const seen = new Set([symbol.id]);
    let frontier = [symbol.id];
    for (let depth = 1; depth <= 3 && reaches.length < 25; depth += 1) {
      const next = [];
      for (const id of frontier) {
        for (const edge of store.neighbours.get(id) ?? []) {
          if (edge.edgeKind !== "calls" || seen.has(edge.id)) continue;
          seen.add(edge.id);
          next.push(edge.id);
          const target = byId.get(edge.id);
          if (target) reaches.push({ id: target.id, name: target.name, path: target.path, depth });
          if (reaches.length >= 25) break;
        }
      }
      frontier = next;
      if (!frontier.length) break;
    }
    return { entrypoint: { id: symbol.id, name: symbol.name, path: symbol.path }, reaches };
  });
}

export const behaviorData = defineSlice({
  id: "behavior-data",
  order: 2,
  // 1.1.0: relationship ends renamed fromComponentId/toComponentId -> fromId/toId, so a
  // dependency on an external system can be expressed.
  contractVersion: "2.0.0",
  dependsOn: ["foundation"],
  title: "Behavior and data",
  schemaFile: "behavior-data.schema.json",
  promptFile: "behavior-data.md",
  entityPrefixes: ["flow", "boundary", "interface", "surface", "contract", "store", "entity", "invariant", "rule"],
  entityArrays: ["runtimeFlows", "boundaries", "apiSurfaces", "dataContracts",
    "stores", "entities", "invariants", "retentionRules", "consistencyRules"],

  buildBriefing(store, { registry = null } = {}) {
    const doc = store.document;
    const take = (kind, n, map) => (doc.detections[kind] ?? []).slice(0, n).map(map);

    return {
      runId: store.runId,
      repository: doc.repository.name,
      // The vocabulary this slice must use, first, so it is read before anything else.
      frozenEntities: registry?.entities ?? [],
      coverage: {
        callEdges: doc.code.calls.length,
        unresolvedCalls: doc.diagnostics?.unresolvedCalls ?? null,
        unsupportedLanguages: doc.diagnostics?.unsupportedLanguages ?? [],
        note: "Unresolved calls are relationships the scanner could not attribute; where "
          + "that count is high, a relationship graph built from call edges is incomplete.",
      },
      entrypoints: take("entrypoints", 20, (e) => ({ id: e.id, name: e.name, path: e.path })),
      routes: take("routes", 40, (r) => ({
        id: r.id, method: r.method, path: r.pathOrName, framework: r.framework,
        implementationPath: r.implementationPath,
        recognizedAuthMiddlewareInFile: r.recognizedAuthMiddlewareInFile,
      })),
      apiSurfaces: take("apiSurfaces", 10, (s) => ({ id: s.id, name: s.name, kind: s.kind })),
      dataStores: take("dataStores", 15, (s) => ({ id: s.id, name: s.name, kind: s.kind })),
      dataEntities: take("dataEntities", 30,
        (e) => ({ id: e.id, name: e.name, tableName: e.tableName, framework: e.framework })),
      dataContracts: take("dataContracts", 30, (c) => ({ id: c.id, name: c.name, kind: c.kind })),
      migrations: take("migrations", 15, (m) => ({ id: m.id, path: m.path, sequence: m.sequence })),
      externalSystems: take("externalSystems", 15, (e) => ({ id: e.id, name: e.name })),
      entrypointNeighbourhoods: entrypointNeighbourhoods(store),
    };
  },

  checks(result, { store, registry }) {
    const errors = [];
    const componentIds = new Set(
      (registry?.entities ?? []).filter((e) => e.kind === "component").map((e) => e.id));

    // A relationship runs from a component to a component, external system, or store.
    //
    // The asymmetry is the point: the depending end must be something this repository
    // contains, while the depended-on end may be outside it. Requiring a component on
    // both sides rejects "the gateway depends on the LLM provider", which is among the
    // most useful things a reader wants to know.
    const externalIds = new Set(
      (registry?.entities ?? []).filter((e) => e.kind === "external-system").map((e) => e.id));
    const storeIds = new Set((result.stores ?? []).map((s) => s.id));

    for (const [i, rel] of (result.relationships ?? []).entries()) {
      if (componentIds.size && !componentIds.has(rel.sourceId)) {
        errors.push({
          code: "not-a-component",
          message: `relationships[${i}].sourceId is ${rel.sourceId}, which is not a frozen component`,
          id: rel.sourceId,
        });
      }
      if ((componentIds.size || externalIds.size || storeIds.size)
        && !componentIds.has(rel.targetId) && !externalIds.has(rel.targetId) && !storeIds.has(rel.targetId)) {
        errors.push({
          code: "unknown-relationship-target",
          message: `relationships[${i}].targetId is ${rel.targetId}, which is not a frozen component, external system, or declared store`,
          id: rel.targetId,
        });
      }
      if (rel.sourceId && rel.sourceId === rel.targetId) {
        errors.push({
          code: "self-relationship",
          message: `relationships[${i}] points a component at itself`,
          id: rel.sourceId,
        });
      }
    }

    // Small repositories can have a single-step flow. Never require invented steps.
    for (const [i, flow] of (result.runtimeFlows ?? []).entries()) {
      if (!(flow.steps ?? []).length) {
        errors.push({
          code: "degenerate-flow",
          message: `runtimeFlows[${i}] has no steps`,
          id: flow.id,
        });
      }
      for (const [j, step] of (flow.steps ?? []).entries()) {
        if ((componentIds.size || externalIds.size) && !componentIds.has(step.actorId) && !externalIds.has(step.actorId)) {
          errors.push({
            code: "not-a-component",
            message: `runtimeFlows[${i}].steps[${j}].actorId is ${step.actorId}, which is not a frozen actor`,
            id: step.actorId,
          });
        }
      }
    }

    // Store and entity enrichments must attach to detections that exist.
    // Store definition paths are claims about the repository and must resolve.
    for (const [i, s] of (result.stores ?? []).entries()) {
      errors.push(...checkPaths(s.definitionPaths, store, { pointer: `stores[${i}]` }));
    }
    for (const [i, e] of (result.entities ?? []).entries()) {
      errors.push(...checkPaths(e.definitionPaths, store, { pointer: `entities[${i}]` }));
    }
    for (const [i, surface] of (result.apiSurfaces ?? []).entries()) {
      for (const [j, endpoint] of (surface.endpoints ?? []).entries()) {
        errors.push(...checkPaths([endpoint.implementationPath], store, {
          pointer: `apiSurfaces[${i}].endpoints[${j}]`, allowPrefix: false,
        }));
      }
    }

    return errors;
  },
});
