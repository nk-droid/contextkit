/**
 * Foundation slice tests (plan §14.1).
 *
 * The slice's job is to be hard to get wrong in ways that matter downstream, so the
 * tests are mostly about rejection: a component owning a path that does not exist, an
 * id reused from the static run, an annotation that quietly rewrites a measurement.
 * Each of those would otherwise become a frozen entity that later slices build on.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { scanRepository } from "../src/analysis/scan-repository.mjs";
import { RunStore } from "../src/analysis/mcp/run-store.mjs";
import { buildProtectedSnapshot } from "../src/analysis/merge/protected-fields.mjs";
import {
  PROMPT_SET_VERSION, SLICE_ID, buildBriefing, buildPrompt, checkAgainstRegistry,
  checkRunBinding, freezeEntityRegistry, loadPrompts, loadSchema, validateFoundation,
} from "../src/analysis/slices/foundation.mjs";
import { lintProviderSchema } from "../src/analysis/slices/schema-lint.mjs";
import { toClaudeSchema } from "../scripts/claude-schema.mjs";

let fixture;
let store;
let snapshot;
let evidenceId;

const codes = (result) => result.errors.map((e) => e.code);

/** A minimal result that validates, so each test can break exactly one thing. */
function validResult(overrides = {}) {
  return {
    project: { purpose: "A small service.", basis: "documented" },
    components: [{
      id: "component.api", name: "API", responsibility: "Serves HTTP requests.",
      kind: "service", paths: ["src"], basis: "observed", evidenceIds: [evidenceId],
    }],
    externalSystems: [],
    annotations: [],
    ...overrides,
  };
}

before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ck-foundation-"));
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(fixture, rel)), { recursive: true });
    fs.writeFileSync(path.join(fixture, rel), content);
  };
  write("package.json", JSON.stringify({
    name: "slice-fixture", version: "1.0.0",
    scripts: { start: "node src/main.js" }, dependencies: { zod: "^3.0.0" },
  }, null, 2));
  write("README.md", "# Slice fixture\n\nA small service used to exercise the foundation slice.\n");
  write("src/main.ts", [
    "export function main() {",
    "  return handle();",
    "}",
    "",
    "export function handle() {",
    "  return 1;",
    "}",
    "",
  ].join("\n"));
  write("src/app/api/items/route.ts", "export function GET() { return 1; }\n");

  const { document } = scanRepository(fixture);
  store = new RunStore(JSON.parse(JSON.stringify(document)), [], { sourceIndexLoaded: false });
  snapshot = buildProtectedSnapshot(store.document);
  evidenceId = store.document.evidence[0].id;
});

after(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

describe("slice contract", () => {
  test("the schema forbids extra fields and requires grounding", () => {
    const schema = loadSchema();
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["project", "components", "externalSystems", "annotations"]);
    assert.deepEqual(schema.$defs.basis.enum, ["observed", "documented", "inferred"]);
    assert.equal(schema.properties.components.items.properties.id.pattern,
      "^component\\.[a-z0-9][a-z0-9._-]*$");
  });

  test("the prompts state the rules the validator enforces", () => {
    const { system, slice } = loadPrompts();
    // If the prompt and the validator disagree, the model is set up to fail.
    for (const phrase of ["not on this filesystem", "report_dispute", "not-checked", "validate_slice"]) {
      assert.ok(system.includes(phrase), `common system prompt should mention ${phrase}`);
    }
    assert.ok(system.includes("absent"), "the protected-field rule is absence, not equality");
    assert.ok(slice.includes("frozen"), "the slice prompt should say ids are frozen");
  });

  test("the prompt carries a briefing and stays a reasonable size", () => {
    const { systemPrompt, prompt, briefing } = buildPrompt(store);
    assert.ok(systemPrompt.length > 500);
    assert.ok(prompt.includes("## Briefing"));
    assert.ok(prompt.includes(briefing.repository.name));
    assert.ok(Buffer.byteLength(prompt) < 200_000, "the briefing must not become the whole artifact");
  });

  test("the briefing states coverage, so absence is not read as evidence", () => {
    const briefing = buildBriefing(store);
    assert.ok(briefing.coverage.note.includes("did not find"));
    assert.ok(Array.isArray(briefing.coverage.unsupportedLanguages));
    assert.equal(briefing.coverage.files, store.document.inventory.files.length);
  });

  test("key symbols favour entrypoints and connectedness", () => {
    const briefing = buildBriefing(store);
    const names = briefing.keySymbols.map((s) => s.name);
    assert.ok(names.includes("main"), `expected main among ${names}`);
    assert.ok(briefing.keySymbols.every((s) => typeof s.connections === "number"));
  });

  test("the briefing carries no host path", () => {
    assert.ok(!JSON.stringify(buildBriefing(store)).includes(fixture));
  });
});

describe("a well-formed result validates", () => {
  test("accepts a minimal grounded result", () => {
    const result = validateFoundation(validResult(), snapshot, store);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("accepts a nested path prefix as component ownership", () => {
    const result = validateFoundation(
      validResult({ components: [{
        id: "component.api", name: "API", responsibility: "Serves requests.",
        kind: "service", paths: ["src/app"], basis: "inferred",
      }] }), snapshot, store);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });

  test("accepts annotations that carry only semantic fields", () => {
    const symbol = store.document.code.symbols[0];
    const result = validateFoundation(validResult({
      annotations: [{
        targetId: symbol.id, basis: "inferred",
        fields: { summary: "Entry point for the service.", componentId: "component.api" },
      }],
    }), snapshot, store);
    assert.equal(result.valid, true, JSON.stringify(result.errors));
  });
});

describe("claims about the repository must resolve", () => {
  test("a component owning a path that does not exist is rejected", () => {
    const result = validateFoundation(validResult({
      components: [{
        id: "component.ghost", name: "Ghost", responsibility: "Imaginary.",
        kind: "service", paths: ["src/does-not-exist"], basis: "inferred",
      }],
    }), snapshot, store);
    assert.equal(result.valid, false);
    assert.ok(codes(result).includes("unknown-path"));
  });

  test("a component owning nothing is rejected", () => {
    const result = validateFoundation(validResult({
      components: [{
        id: "component.vague", name: "Vague", responsibility: "Unclear.",
        kind: "service", paths: [], basis: "inferred",
      }],
    }), snapshot, store);
    assert.ok(codes(result).includes("component-without-paths"));
  });

  test("observed claims without evidence are rejected", () => {
    const result = validateFoundation(validResult({
      project: { purpose: "A service.", basis: "observed", evidenceIds: [] },
    }), snapshot, store);
    assert.ok(codes(result).includes("observed-without-evidence"));
  });

  test("invented evidence is rejected", () => {
    const result = validateFoundation(validResult({
      project: { purpose: "A service.", basis: "observed", evidenceIds: ["ev.invented.0000"] },
    }), snapshot, store);
    assert.ok(codes(result).includes("unresolved-evidence"));
  });
});

describe("entity ids", () => {
  test("an id reused from the static run is rejected", () => {
    const symbolId = store.document.code.symbols[0].id;
    const result = validateFoundation(validResult({
      components: [{
        id: symbolId, name: "Collides", responsibility: "Shadows a symbol.",
        kind: "service", paths: ["src"], basis: "inferred",
      }],
    }), snapshot, store);
    assert.ok(codes(result).includes("entity-id-collision") || codes(result).includes("bad-entity-id"));
  });

  test("a duplicate id inside the slice is rejected", () => {
    const component = {
      id: "component.api", name: "API", responsibility: "Serves.",
      kind: "service", paths: ["src"], basis: "inferred",
    };
    const result = validateFoundation(
      validResult({ components: [component, { ...component, name: "API again" }] }), snapshot, store);
    assert.ok(codes(result).includes("duplicate-entity-id"));
  });

  test("a malformed id is rejected", () => {
    const result = validateFoundation(validResult({
      components: [{
        id: "Component One!", name: "Bad", responsibility: "Bad id.",
        kind: "service", paths: ["src"], basis: "inferred",
      }],
    }), snapshot, store);
    assert.ok(codes(result).includes("bad-entity-id"));
  });
});

describe("the scanner's measurements stay the scanner's", () => {
  test("an annotation rewriting a measured field is rejected", () => {
    const symbol = store.document.code.symbols[0];
    const result = validateFoundation(validResult({
      annotations: [{
        targetId: symbol.id, basis: "inferred",
        fields: { summary: "fine", lineStart: 1, path: "src/elsewhere.ts" },
      }],
    }), snapshot, store);
    assert.equal(result.valid, false);
    const fields = result.errors.filter((e) => e.code === "protected-field").map((e) => e.field);
    assert.deepEqual(fields.sort(), ["lineStart", "path"]);
  });

  test("an annotation on an unknown record is rejected", () => {
    const result = validateFoundation(validResult({
      annotations: [{ targetId: "sym.not.here", basis: "inferred", fields: { summary: "x" } }],
    }), snapshot, store);
    assert.ok(codes(result).includes("unknown-target"));
  });

  test("a host path in prose is rejected", () => {
    const symbol = store.document.code.symbols[0];
    const result = validateFoundation(validResult({
      annotations: [{
        targetId: symbol.id, basis: "inferred",
        fields: { summary: "defined in /Users/someone/work/repo/src/main.ts" },
      }],
    }), snapshot, store);
    assert.ok(codes(result).includes("host-path-in-prose"));
  });

});

describe("stored responses stay tied to their run", () => {
  // A response outlives its process. Read back against a different scan, its ids would
  // still look valid and the annotations would land on unrelated code.
  const bound = {
    result: validResult(),
    boundTo: { artifactId: undefined, treeFingerprint: undefined },
  };

  test("a response recording its run is accepted", () => {
    const envelope = { ...bound, boundTo: {
      artifactId: snapshot.artifactId, treeFingerprint: snapshot.treeFingerprint } };
    assert.equal(checkRunBinding(envelope, snapshot).valid, true);
  });

  test("a response from another artifact is refused", () => {
    const envelope = { boundTo: {
      artifactId: "static.other.0000", treeFingerprint: snapshot.treeFingerprint } };
    const outcome = checkRunBinding(envelope, snapshot);
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((e) => e.code === "artifact-mismatch"));
  });

  test("a response from another tree is refused", () => {
    const envelope = { boundTo: {
      artifactId: snapshot.artifactId, treeFingerprint: "0".repeat(64) } };
    const outcome = checkRunBinding(envelope, snapshot);
    assert.ok(outcome.errors.some((e) => e.code === "fingerprint-mismatch"));
  });

  test("a response recording nothing is refused rather than assumed", () => {
    const outcome = checkRunBinding({ result: validResult() }, snapshot);
    assert.equal(outcome.valid, false);
    assert.ok(outcome.errors.some((e) => e.code === "unbound-response"));
  });
});

describe("entity registry freeze", () => {
  test("records every component and external system, sorted", () => {
    const registry = freezeEntityRegistry(validResult({
      components: [
        { id: "component.b", name: "B", responsibility: "b", kind: "service", paths: ["src"], basis: "inferred" },
        { id: "component.a", name: "A", responsibility: "a", kind: "library", paths: ["src"], basis: "inferred" },
      ],
      externalSystems: [
        { id: "external.stripe", name: "Stripe", integrationKind: "payment", basis: "inferred" },
      ],
    }), { snapshot });

    assert.deepEqual(registry.entityIds, ["component.a", "component.b", "external.stripe"]);
    assert.equal(registry.artifactId, snapshot.artifactId);
    assert.equal(registry.treeFingerprint, snapshot.treeFingerprint);
    assert.equal(registry.sliceId, SLICE_ID);
  });

  test("a later slice referencing an unknown entity is caught", () => {
    const registry = freezeEntityRegistry(validResult(), { snapshot });
    assert.deepEqual(checkAgainstRegistry(registry, ["component.api"]), []);
    assert.deepEqual(
      checkAgainstRegistry(registry, ["component.api", "component.invented"]),
      ["component.invented"]);
  });

  test("the registry pins the run it was frozen against", () => {
    // A registry that did not name its run could silently be applied to another scan,
    // where the same component ids would mean different code.
    const registry = freezeEntityRegistry(validResult(), { snapshot });
    assert.match(registry.treeFingerprint, /^[0-9a-f]{64}$/);
    assert.ok(registry.frozenAt);
  });
});

describe("versioning", () => {
  test("the prompt set is versioned, so results can be compared across changes", () => {
    assert.match(PROMPT_SET_VERSION, /^\d+\.\d+\.\d+$/);
  });
});

describe("the schema a provider will actually compile", () => {
  // This class of failure is expensive to find any other way: the provider rejects the
  // schema after the prompt has been sent, reporting one line on stderr, minutes in.
  test("the normalized schema passes strict-compiler rules", () => {
    const normalized = toClaudeSchema(loadSchema());
    const lint = lintProviderSchema(normalized);
    assert.equal(lint.ok, true, JSON.stringify(lint.problems, null, 2));
  });

  test("normalization is what makes it acceptable, so it cannot be skipped", () => {
    // The raw schema is portable JSON Schema and deliberately keeps $defs; the adapter
    // converts it. If that step is ever dropped, this test says why it mattered.
    const raw = lintProviderSchema(loadSchema());
    assert.equal(raw.ok, false);
    assert.ok(raw.problems.some((p) => p.rule === "defs-under-draft-07"));
  });

  test("the lint catches each rule it exists for", () => {
    const union = lintProviderSchema({
      type: "object", properties: { x: { type: ["string", "null"] } },
    });
    assert.ok(union.problems.some((p) => p.rule === "union-type"));

    const required = lintProviderSchema({
      type: "object", required: ["missing"], properties: { present: { type: "string" } },
    });
    assert.ok(required.problems.some((p) => p.rule === "required-undescribed"));

    const dangling = lintProviderSchema({
      type: "object", properties: { x: { $ref: "#/definitions/nope" } },
    });
    assert.ok(dangling.problems.some((p) => p.rule === "dangling-ref"));
  });

  test("the lint reaches into nested subschemas", () => {
    const nested = lintProviderSchema({
      type: "object",
      properties: {
        list: { type: "array", items: { type: "object",
          properties: { bad: { type: ["string", "number"] } } } },
      },
    });
    assert.ok(nested.problems.some((p) => p.rule === "union-type" && p.pointer.includes("items")));
  });
});
