/**
 * Slice planning (ANALYSIS_PLAN.json, plan §6.2).
 *
 * Records which slices will run, in what order, against which run, with which prompts.
 * Written before any provider is contacted, so a run can be resumed, audited, or
 * compared against another without reconstructing intent from whatever files happen to
 * exist afterwards.
 *
 * Order is derived from declared dependencies rather than written down twice: a slice
 * says what it needs, and the plan works out the sequence. Two places to edit is one
 * place too many for something that decides what references resolve.
 */
import { foundation } from "./foundation.mjs";
import { behaviorData } from "./behavior-data.mjs";
import { PROMPT_SET_VERSION } from "./slice-kit.mjs";

/** Every slice ContextKit can run, keyed by id. */
export const SLICES = Object.freeze({
  [foundation.id]: foundation,
  [behaviorData.id]: behaviorData,
});

export function getSlice(id) {
  return SLICES[id] ?? null;
}

/**
 * Topological order over declared dependencies.
 *
 * Throws on a cycle rather than picking an order, because a cycle means two slices each
 * expect the other's registry - there is no correct sequence, and running one anyway
 * produces references that cannot resolve.
 */
export function orderSlices(ids = Object.keys(SLICES)) {
  const wanted = new Set(ids);
  const ordered = [];
  const state = new Map();

  const visit = (id, trail) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      throw new Error(`slice dependency cycle: ${[...trail, id].join(" -> ")}`);
    }
    const slice = SLICES[id];
    if (!slice) throw new Error(`unknown slice: ${id}`);
    state.set(id, "visiting");
    for (const dependency of slice.dependsOn) {
      if (!SLICES[dependency]) throw new Error(`${id} depends on unknown slice ${dependency}`);
      visit(dependency, [...trail, id]);
    }
    state.set(id, "done");
    ordered.push(slice);
  };

  for (const id of ids) visit(id, []);
  // A dependency pulled in implicitly still runs; the plan says so rather than hiding it.
  return ordered.map((slice) => ({ slice, requested: wanted.has(slice.id) }));
}

/**
 * Build the plan for a run.
 *
 * @param {object} store loaded run
 * @param {{sliceIds?: string[], provider?: string, model?: string|null,
 *          profile?: string, sourceExposure?: string}} options
 */
export function buildAnalysisPlan(store, {
  sliceIds = Object.keys(SLICES), provider = "claude", model = null,
  profile = "standard", sourceExposure = "static-only",
} = {}) {
  const summary = store.summary();
  const steps = orderSlices(sliceIds).map(({ slice, requested }, index) => ({
    order: index + 1,
    sliceId: slice.id,
    title: slice.title,
    dependsOn: slice.dependsOn,
    requested,
    reason: requested ? "requested" : "required by a requested slice",
    contractVersion: slice.contractVersion,
    schemaHash: slice.schemaHash(),
    schema: slice.schemaFile,
    prompt: slice.promptFile,
    entityPrefixes: slice.entityPrefixes,
    // What this slice is allowed to add to the registry, so a reader can see where an
    // id came from without running anything.
    freezesRegistry: slice.id === foundation.id,
  }));

  return {
    schemaVersion: 1,
    runId: summary.runId,
    repository: summary.repository,
    treeFingerprint: summary.treeFingerprint,
    createdAt: new Date().toISOString(),
    promptSetVersion: PROMPT_SET_VERSION,
    profile,
    provider,
    model,
    sourceExposure,
    snapshot: {
      files: summary.files, symbols: summary.symbols,
      calls: summary.calls, evidence: summary.evidence,
    },
    steps,
  };
}

/** Which slices a plan still has to run, given what is already on disk. */
export function remainingSteps(plan, completedSliceIds) {
  const done = new Set(completedSliceIds);
  return plan.steps.filter((step) => !done.has(step.sliceId));
}
