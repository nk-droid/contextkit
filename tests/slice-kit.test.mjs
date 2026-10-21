/**
 * Slice kit, planning, and conflict tests.
 *
 * The kit exists so five slices share one set of rules rather than drifting into five.
 * These tests pin the shared behaviour: what a slice may mint, what it must resolve
 * against the frozen registry, and what happens when two slices disagree.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { scanRepository } from "../src/analysis/scan-repository.mjs";
import { RunStore } from "../src/analysis/mcp/run-store.mjs";
import { ContextKitMcpServer } from "../src/analysis/mcp/server.mjs";
import { normalizeSliceIds } from "../src/analysis/slices/normalize-ids.mjs";
import { buildProtectedSnapshot } from "../src/analysis/merge/protected-fields.mjs";
import {
  buildSlicePrompt, collectReferences, validateSliceResult,
} from "../src/analysis/slices/slice-kit.mjs";
import { behaviorData } from "../src/analysis/slices/behavior-data.mjs";
import { foundation } from "../src/analysis/slices/foundation.mjs";
import {
  SLICES, buildAnalysisPlan, orderSlices, remainingSteps,
} from "../src/analysis/slices/plan-slices.mjs";
import {
  buildReconciliationRequest, priorityOf, reconcile, reconcileAll,
} from "../src/analysis/merge/conflicts.mjs";
import { loadFinalSchema } from "../src/analysis/slices/derive-schema.mjs";
import { OWNERSHIP, unclaimedArrays } from "../src/analysis/slices/ownership.mjs";

let fixture;
let store;
let snapshot;
let registry;
let evidenceId;

const codes = (r) => r.errors.map((e) => e.code);

before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ck-kit-"));
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(fixture, rel)), { recursive: true });
    fs.writeFileSync(path.join(fixture, rel), content);
  };
  write("package.json", '{"name":"kit-fixture","version":"1.0.0"}');
  write("src/api.ts", [
    "export function handle(request) {",
    "  return persist(request);",
    "}",
    "",
    "export function persist(value) {",
    "  return value;",
    "}",
    "",
  ].join("\n"));

  const { document } = scanRepository(fixture);
  store = new RunStore(JSON.parse(JSON.stringify(document)), [], { sourceIndexLoaded: false });
  snapshot = buildProtectedSnapshot(store.document);
  evidenceId = store.document.evidence[0].id;
  registry = {
    entityIds: ["component.api", "component.storage", "external.github"],
    entities: [
      { id: "component.api", kind: "component", name: "API", paths: ["src"] },
      { id: "component.storage", kind: "component", name: "Storage", paths: ["src"] },
      { id: "external.github", kind: "external-system", name: "GitHub" },
    ],
  };
});

after(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

/** Grounding in the shape the final contract defines. */
const grounding = (basis = "inferred", evidenceIds = []) => ({
  basis, confidence: "medium", evidenceIds, claimIds: [], notes: [],
});

/**
 * A behavior-data result that validates, so each test breaks exactly one thing.
 * Field names come from the final contract, because the slice schema is cut from it.
 */
function validBehavior(overrides = {}) {
  return {
    relationships: [{
      id: "relationship.api-storage",
      sourceId: "component.api", targetId: "component.storage",
      kind: "writes-to", label: "persists records", summary: "The API writes through storage.",
      direction: "outbound", synchronous: true, optional: false,
      dataExchanged: ["record payloads"], failureBehavior: "request fails",
      grounding: grounding(),
    }],
    runtimeFlows: [{
      id: "flow.request", name: "Request", kind: "request", trigger: "HTTP request",
      outcome: "Record persisted", actorIds: ["component.api", "component.storage"], alternatePaths: [], failureModes: [],
      steps: [
        { id: "step.accept", order: 1, actorId: "component.api", action: "accepts the request", inputs: [], outputs: [], conditions: [], stateChanges: [], failureBehavior: null, grounding: grounding() },
        { id: "step.persist", order: 2, actorId: "component.storage", action: "persists it", inputs: [], outputs: [], conditions: [], stateChanges: [], failureBehavior: null, grounding: grounding() },
      ],
      grounding: grounding(),
    }],
    boundaries: [],
    invariants: [],
    apiSurfaces: [],
    dataContracts: [],
    stores: [],
    entities: [],
    retentionRules: [],
    consistencyRules: [],
    annotations: [],
    ...overrides,
  };
}

const ctx = () => ({ snapshot, store, registry });

describe("shared slice rules", () => {
  test("Codex MCP preflight decodes annotation entries without changing the candidate", () => {
    const server = new ContextKitMcpServer(store, { registry, provider: "codex" });
    const candidate = validBehavior({ annotations: [{
      targetId: "src/api.ts", basis: "inferred", evidenceIds: [],
      fields: [{ key: "summary", value: "Handles requests." }],
    }] });
    const before = structuredClone(candidate);
    const accepted = server.callTool("validate_slice", { sliceId: "behavior-data", candidate });
    assert.equal(accepted.result.valid, true, JSON.stringify(accepted));
    assert.deepEqual(candidate, before);
    candidate.annotations[0].fields.push({ key: "summary", value: "Contradicts the first value." });
    const rejected = server.callTool("validate_slice", { sliceId: "behavior-data", candidate });
    assert.equal(rejected.ok, false);
    assert.match(rejected.error.message, /Duplicate annotation field/);
  });

  test("MCP preflight uses the complete contract and frozen registry", () => {
    const server = new ContextKitMcpServer(store, { registry });
    const check = (sliceId, candidate) => server.callTool("validate_slice", { sliceId, candidate }).result;
    assert.equal(check("foundation", { annotations: [] }).valid, false);
    assert.equal(check("behavior-data", validBehavior()).valid, true);
    const invalid = validBehavior();
    invalid.relationships[0].targetId = "component.invented";
    assert.equal(check("behavior-data", invalid).valid, false);
    const missingRegistry = new ContextKitMcpServer(store).callTool("validate_slice", {
      sliceId: "behavior-data", candidate: validBehavior(),
    }).result;
    assert.equal(missingRegistry.valid, false);
    assert.ok(missingRegistry.violations.some((e) => e.code === "missing-registry"));
  });

  test("a well-formed result validates", () => {
    const result = validateSliceResult(validBehavior(), behaviorData, ctx());
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("annotations can reference a scanned file by path", () => {
    const result = validateSliceResult(validBehavior({
      annotations: [{
        targetId: "src/api.ts", basis: "inferred", evidenceIds: [],
        fields: { summary: "Accepts requests and persists their payloads." },
      }],
    }), behaviorData, ctx());
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("a slice may only mint ids in its own namespace", () => {
    const result = validateSliceResult(validBehavior({
      runtimeFlows: [{ ...validBehavior().runtimeFlows[0], id: "component.sneaky" }],
    }), behaviorData, ctx());
    assert.ok(codes(result).includes("entity-outside-namespace"));
  });

  test("a slice may not redeclare an entity an earlier slice froze", () => {
    const result = validateSliceResult(validBehavior({
      runtimeFlows: [{ ...validBehavior().runtimeFlows[0], id: "flow.request" }],
      boundaries: [{ id: "flow.request", name: "Clash", kind: "trust", grounding: grounding() }],
    }), behaviorData, ctx());
    assert.ok(codes(result).includes("duplicate-entity-id"));
  });

  test("references must resolve through the frozen registry", () => {
    const result = validateSliceResult(validBehavior({
      relationships: [{
        sourceId: "component.api", targetId: "component.invented",
        kind: "calls", grounding: grounding(),
      }],
    }), behaviorData, ctx());
    assert.ok(codes(result).includes("unresolved-reference")
      || codes(result).includes("unknown-relationship-target"),
      `expected an unresolved reference; got ${codes(result)}`);
  });

  test("observed claims anywhere in the result need evidence", () => {
    const result = validateSliceResult(validBehavior({
      runtimeFlows: [{ ...validBehavior().runtimeFlows[0], grounding: grounding("observed", []) }],
    }), behaviorData, ctx());
    assert.ok(codes(result).includes("observed-without-evidence"));
  });

  test("evidence must exist in this run", () => {
    const result = validateSliceResult(validBehavior({
      runtimeFlows: [{ ...validBehavior().runtimeFlows[0], grounding: grounding("observed", ["ev.nope.0000"]) }],
    }), behaviorData, ctx());
    assert.ok(codes(result).includes("unresolved-evidence"));
  });

  test("a protected field in an annotation is rejected, as in every other slice", () => {
    const symbol = store.document.code.symbols[0];
    const result = validateSliceResult(validBehavior({
      annotations: [{ targetId: symbol.id, basis: "inferred", fields: { lineStart: "1" } }],
    }), behaviorData, ctx());
    assert.ok(codes(result).includes("protected-field"));
  });

  test("references are found wherever they are nested", () => {
    const found = collectReferences({
      a: { b: [{ componentId: "component.x" }] },
      runtimeFlows: [{ steps: [{ componentId: "component.y" }] }],
      other: { entityIds: ["entity.z"] },
    }).map(([, id]) => id);
    assert.deepEqual(found.sort(), ["component.x", "component.y", "entity.z"]);
  });
});

describe("behavior-data specific rules", () => {
  test("scanner-backed stores receive distinct semantic IDs with references preserved", () => {
    const doc = structuredClone(store.document);
    doc.detections.dataStores.push({ id: "store.redis", name: "Redis", kind: "cache" });
    const scopedStore = new RunStore(doc, [], { sourceIndexLoaded: false });
    const result = validBehavior({ stores: [{
      id: "store.redis", name: "Redis", kind: "cache", technologyId: null,
      purpose: "Caches records", durability: "ephemeral", accessEntityIds: ["component.api"],
      definitionPaths: ["src/api.ts"], sensitiveData: [], grounding: grounding(),
    }], annotations: [{ targetId: "store.redis", basis: "inferred", fields: { purpose: "Caches records" } }] });
    result.relationships[0].targetId = "store.redis";
    const original = structuredClone(result);
    const normalized = normalizeSliceIds(result, behaviorData, scopedStore);
    assert.deepEqual(result, original, "normalization must preserve the provider response");
    assert.equal(normalized.mappings.length, 1);
    assert.notEqual(normalized.result.stores[0].id, "store.redis");
    assert.equal(normalized.result.relationships[0].targetId, normalized.result.stores[0].id);
    assert.equal(normalized.result.annotations[0].targetId, "store.redis");
    assert.equal(normalizeSliceIds(normalized.result, behaviorData, scopedStore).mappings.length, 0);
    const checked = validateSliceResult(result, behaviorData, {
      store: scopedStore, snapshot: buildProtectedSnapshot(doc), registry,
    });
    assert.equal(checked.valid, true, JSON.stringify(checked.errors));
    result.stores.push(structuredClone(result.stores[0]));
    assert.ok(codes(validateSliceResult(result, behaviorData, {
      store: scopedStore, snapshot: buildProtectedSnapshot(doc), registry,
    })).includes("duplicate-entity-id"), "normalization must not hide duplicates");
  });

  test("the depending end must be a component in this repository", () => {
    const result = validateSliceResult(validBehavior({
      relationships: [{
        sourceId: "flow.request", targetId: "component.storage",
        kind: "calls", grounding: grounding(),
      }],
    }), behaviorData, ctx());
    assert.ok(codes(result).includes("not-a-component"));
  });

  test("a dependency on an external system is a relationship, not an error", () => {
    // The asymmetry that a first version got wrong: requiring a component on both ends
    // rejects "the gateway depends on the LLM provider", which is exactly what a reader
    // most wants to know.
    const result = validateSliceResult(validBehavior({
      relationships: [{
        ...validBehavior().relationships[0], sourceId: "component.api", targetId: "external.github",
        kind: "depends-on", grounding: grounding(),
      }],
    }), behaviorData, ctx());
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("a relationship to something in no registry is still rejected", () => {
    const result = validateSliceResult(validBehavior({
      relationships: [{
        sourceId: "component.api", targetId: "external.invented",
        kind: "depends-on", grounding: grounding(),
      }],
    }), behaviorData, ctx());
    assert.ok(codes(result).includes("unknown-relationship-target"));
  });

  test("a component pointing at itself is rejected", () => {
    const result = validateSliceResult(validBehavior({
      relationships: [{
        sourceId: "component.api", targetId: "component.api",
        kind: "calls", grounding: grounding(),
      }],
    }), behaviorData, ctx());
    assert.ok(codes(result).includes("self-relationship"));
  });

  test("an empty flow is rejected as degenerate", () => {
    const result = validateSliceResult(validBehavior({
      runtimeFlows: [{
        id: "flow.tiny", name: "Tiny", trigger: "x",
        steps: [],
        grounding: grounding(),
      }],
    }), behaviorData, ctx());
    assert.ok(codes(result).includes("degenerate-flow"));
  });

  test("a small repository can have a single-step flow", () => {
    const flow = validBehavior().runtimeFlows[0];
    flow.steps = flow.steps.slice(0, 1);
    flow.actorIds = ["component.api"];
    const result = validateSliceResult(validBehavior({ runtimeFlows: [flow] }), behaviorData, ctx());
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("a flow step citing an unknown actor is rejected", () => {
    const flow = validBehavior().runtimeFlows[0];
    flow.steps[0].actorId = "component.not.real";
    const result = validateSliceResult(validBehavior({ runtimeFlows: [flow] }), behaviorData, ctx());
    assert.ok(codes(result).includes("not-a-component"));
  });

  test("a flow step citing an external actor is accepted", () => {
    const flow = validBehavior().runtimeFlows[0];
    flow.steps[0].actorId = "external.github";
    const result = validateSliceResult(validBehavior({ runtimeFlows: [flow] }), behaviorData, ctx());
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("a store claiming a path that does not exist is rejected", () => {
    const result = validateSliceResult(validBehavior({
      stores: [{
        id: "store.imaginary", name: "Ghost", kind: "relational-database",
        definitionPaths: ["src/nowhere.ts"], grounding: grounding(),
      }],
    }), behaviorData, ctx());
    assert.ok(codes(result).includes("unknown-path"));
  });

  test("the briefing leads with the frozen registry", () => {
    const briefing = behaviorData.buildBriefing(store, { registry });
    assert.equal(Object.keys(briefing)[2], "frozenEntities",
      "the vocabulary a slice must reuse should be read before anything it might name itself");
    assert.equal(briefing.frozenEntities.length, registry.entities.length);
    assert.ok(briefing.coverage.note.includes("incomplete"));
  });
});

describe("slice planning", () => {
  test("order follows declared dependencies", () => {
    const order = orderSlices().map((s) => s.slice.id);
    assert.ok(order.indexOf("foundation") < order.indexOf("behavior-data"));
  });

  test("a dependency is pulled in and marked as such", () => {
    const steps = orderSlices(["behavior-data"]);
    assert.deepEqual(steps.map((s) => s.slice.id), ["foundation", "behavior-data"]);
    assert.equal(steps[0].requested, false);
    assert.equal(steps[1].requested, true);
  });

  test("an unknown slice is refused rather than skipped", () => {
    assert.throws(() => orderSlices(["nope"]), /unknown slice/);
  });

  test("a cycle is refused rather than ordered arbitrarily", () => {
    const original = foundation.dependsOn;
    foundation.dependsOn = ["behavior-data"];
    try {
      assert.throws(() => orderSlices(), /cycle/);
    } finally {
      foundation.dependsOn = original;
    }
  });

  test("the plan pins the run, the prompts, and the exposure", () => {
    const plan = buildAnalysisPlan(store, { provider: "claude", sourceExposure: "static-only" });
    assert.equal(plan.runId, store.runId);
    assert.equal(plan.treeFingerprint, store.document.repository.treeFingerprint);
    assert.match(plan.promptSetVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(plan.sourceExposure, "static-only");
    assert.equal(plan.steps[0].sliceId, "foundation");
    assert.equal(plan.steps[0].freezesRegistry, true);
    assert.equal(plan.steps[1].freezesRegistry, false);
  });

  test("remaining steps exclude what has already run", () => {
    const plan = buildAnalysisPlan(store);
    assert.deepEqual(remainingSteps(plan, ["foundation"]).map((s) => s.sliceId), ["behavior-data"]);
    assert.deepEqual(remainingSteps(plan, Object.keys(SLICES)), []);
  });
});

describe("conflict rules", () => {
  const claim = (value, basis, extra = {}) => ({ subject: "purpose", value, basis, ...extra });

  test("an observation outranks documentation, which outranks inference", () => {
    assert.ok(priorityOf("observed") > priorityOf("documented"));
    assert.ok(priorityOf("documented") > priorityOf("inferred"));
    assert.equal(priorityOf("nonsense"), 0);
  });

  test("the better-grounded claim wins and the other is kept as displaced", () => {
    const outcome = reconcile("purpose", [claim("A", "inferred"), claim("B", "observed", { evidenceIds: [evidenceId] })]);
    assert.equal(outcome.resolution, "resolved");
    assert.equal(outcome.winner.value, "B");
    assert.equal(outcome.displaced.length, 1);
    assert.equal(outcome.displaced[0].value, "A", "the loser must remain visible");
  });

  test("equally grounded claims that agree are not a conflict", () => {
    const outcome = reconcile("purpose", [claim("same", "inferred"), claim("same", "inferred")]);
    assert.equal(outcome.resolution, "agreed");
    assert.equal(outcome.contested, false);
  });

  test("equally grounded claims that disagree are contested, not decided", () => {
    // This is the rule the whole module exists for: no last-write-wins.
    const outcome = reconcile("purpose", [
      claim("first", "inferred", { sliceId: "behavior-data" }),
      claim("second", "inferred", { sliceId: "assurance" }),
    ]);
    assert.equal(outcome.resolution, "contested");
    assert.equal(outcome.winner, null, "neither may be silently chosen");
    assert.equal(outcome.candidates.length, 2);
  });

  test("an unsupported suggestion never wins", () => {
    const outcome = reconcile("purpose", [claim("guess", "unsupported")]);
    assert.equal(outcome.resolution, "unsupported");
    assert.equal(outcome.winner, null);
  });

  test("documentation contradicted by implementation is recorded, not dropped", () => {
    const { contradictions, summary } = reconcileAll([
      claim("uses Postgres", "documented"),
      claim("uses SQLite", "observed", { evidenceIds: [evidenceId] }),
    ]);
    assert.equal(contradictions.length, 1);
    assert.equal(contradictions[0].resolution, "implementation-kept");
    assert.equal(contradictions[0].implementation.value, "uses SQLite");
    assert.equal(contradictions[0].documentation.value, "uses Postgres");
    assert.equal(summary.contradictionCount, 1);
  });

  test("documentation that agrees with implementation is not a contradiction", () => {
    const { contradictions } = reconcileAll([
      claim("uses SQLite", "documented"),
      claim("uses SQLite", "observed", { evidenceIds: [evidenceId] }),
    ]);
    assert.equal(contradictions.length, 0);
  });

  test("nothing is dropped without being counted", () => {
    const { summary } = reconcileAll([
      claim("a", "inferred"), claim("b", "observed", { evidenceIds: [evidenceId] }),
      { subject: "other", value: "x", basis: "inferred" },
    ]);
    assert.equal(summary.subjects, 2);
    assert.equal(summary.displacedCount, 1);
  });

  test("a reconciliation request can only choose between what exists", () => {
    const outcome = reconcile("purpose", [
      claim("first", "inferred"), claim("second", "inferred"),
    ]);
    const request = buildReconciliationRequest(outcome);
    assert.equal(request.candidates.length, 2);
    assert.deepEqual(request.allowedAnswers, ["option-<n>", "unresolved"]);
    assert.ok(request.instruction.includes("Do not propose a third answer"));
  });
});

describe("prompts and schemas describe the same thing", () => {
  // The bug this prevents cost a full analysis run: slice schemas were hand-written from
  // the plan's prose while the document expected different field names, so nothing the
  // model produced could be assembled. The schema is now cut from the contract, and this
  // checks the prompt kept up with it.
  for (const [id, slice] of Object.entries(SLICES)) {
    test(`${id}: the prompt names every array its schema demands`, () => {
      const { slice: instructions } = slice.loadPrompts();
      const arrays = Object.entries(slice.loadSchema().properties)
        .filter(([, v]) => v["x-target"])
        .map(([k]) => k);
      const unmentioned = arrays.filter((a) => !instructions.includes(a));
      assert.deepEqual(unmentioned, [],
        `${id} asks for arrays its prompt never mentions: ${unmentioned.join(", ")}`);
    });

    test(`${id}: every array it produces has a home in the final document`, () => {
      const schema = slice.loadSchema();
      const final = loadFinalSchema();
      const defs = final.$defs ?? {};
      const deref = (n) => (n?.$ref ? defs[n.$ref.split("/").pop()] ?? {} : n);
      for (const [key, value] of Object.entries(schema.properties)) {
        const target = value["x-target"];
        if (!target) continue;
        const [section, array] = target.split(".");
        const sectionSchema = deref(final.properties[section]);
        assert.ok(sectionSchema?.properties?.[array],
          `${id}.${key} targets ${target}, which the document does not have`);
      }
    });
  }

  test("every array in the final document has exactly one producer", () => {
    // A section nothing produces is a hole that assembly would fill with silence.
    assert.deepEqual(unclaimedArrays(loadFinalSchema()), []);

    const seen = new Map();
    for (const [sliceId, owns] of Object.entries(OWNERSHIP)) {
      for (const { section, array } of owns) {
        const key = `${section}.${array}`;
        assert.ok(!seen.has(key),
          `${key} is claimed by both ${seen.get(key)} and ${sliceId}`);
        seen.set(key, sliceId);
      }
    }
  });
});

describe("the id rule the model sees matches the one enforced", () => {
  // Restating the namespaces in prose is how the prompt and the validator drift, and a
  // model rejected for following its instructions is the worst failure mode here.
  for (const [id, slice] of Object.entries(SLICES)) {
    test(`${id}: every enforced prefix appears in the prompt`, () => {
      const { prompt } = buildSlicePrompt(slice, store, { registry: { entities: [], entityIds: [] } });
      for (const prefix of slice.entityPrefixes) {
        assert.ok(prompt.includes(`\`${prefix}.\``),
          `${id} enforces ${prefix}. but never tells the model about it`);
      }
    });

    test(`${id}: an id using an advertised prefix is accepted`, () => {
      if (!slice.entityPrefixes.length || !slice.entityArrays?.length) return;
      const array = slice.entityArrays[0];
      const minted = `${slice.entityPrefixes[0]}.generated-example`;
      const result = validateSliceResult(
        { [array]: [{ id: minted, grounding: { basis: "inferred", confidence: "low", evidenceIds: [], claimIds: [], notes: [] } }] },
        slice, { snapshot, store, registry: null });
      assert.ok(!result.errors.some((e) => e.code === "entity-outside-namespace"),
        `${minted} was rejected despite matching an advertised prefix`);
    });
  }
});
