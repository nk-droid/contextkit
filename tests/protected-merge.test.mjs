/**
 * Protected-field enforcement tests.
 *
 * These are the fixture-based demonstration Phase 0 asks for: model output cannot
 * replace a path, hash, version, symbol location, or call endpoint. Most cases are
 * hostile on purpose - the point of the boundary is what it refuses.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { scanRepository } from "../src/analysis/scan-repository.mjs";
import {
  SEMANTIC_FIELDS, UNANNOTATABLE_KINDS, buildProtectedSnapshot, mergeAnnotations,
  semanticFieldsFor, validateAnnotations,
} from "../src/analysis/merge/protected-fields.mjs";

let fixture;
let document;
let snapshot;

/** A slice envelope that passes the artifact/fingerprint checks, so tests isolate one rule. */
function sliceWith(annotations, extra = {}) {
  return {
    sliceId: "foundation",
    artifactId: document.artifactId,
    treeFingerprint: document.repository.treeFingerprint,
    annotations,
    ...extra,
  };
}

const codesOf = (result) => result.violations.map((v) => v.code);

before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ck-merge-"));
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(fixture, rel)), { recursive: true });
    fs.writeFileSync(path.join(fixture, rel), content);
  };
  write("package.json", JSON.stringify({
    name: "merge-fixture", version: "1.0.0", dependencies: { zod: "^3.0.0" },
  }, null, 2));
  write("src/store.ts", [
    "export function openConnection(url) {",
    "  return { url };",
    "}",
    "",
    "export function loadUser(id) {",
    "  return openConnection(id);",
    "}",
    "",
  ].join("\n"));
  ({ document } = scanRepository(fixture));
  snapshot = buildProtectedSnapshot(document);
});

after(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

describe("ownership spec", () => {
  test("covers every detection collection the scanner emits", () => {
    for (const collection of Object.keys(document.detections)) {
      assert.ok(semanticFieldsFor(`detections.${collection}`),
        `detections.${collection} has no ownership rule; a new collection defaults to unannotatable`);
    }
  });

  test("no semantic field collides with a field the scanner writes", () => {
    // The allowlist is only safe while it names fields the scanner never sets.
    for (const entry of snapshot.records.values()) {
      const allowed = semanticFieldsFor(entry.kind);
      if (!allowed) continue;
      for (const field of allowed) {
        assert.ok(!Object.hasOwn(entry.protected, field),
          `${entry.kind}.${field} is both scanner-written and model-writable`);
      }
    }
  });

  test("evidence and repository identity cannot be annotated at all", () => {
    for (const kind of ["evidence", "repository", "inspection"]) {
      assert.ok(UNANNOTATABLE_KINDS.has(kind));
      assert.equal(semanticFieldsFor(kind), null);
    }
  });
});

describe("protected fields are refused", () => {
  const cases = [
    ["a file path", "inventory.files", (id) => id, { path: "src/elsewhere.ts" }],
    ["a file hash", "inventory.files", (id) => id, { sha256: "0".repeat(64) }],
    ["a file size", "inventory.files", (id) => id, { bytes: 1 }],
    ["a symbol location", "code.symbols", null, { lineStart: 999 }],
    ["a symbol signature", "code.symbols", null, { signature: "openConnection(): void" }],
    ["a symbol's evidence", "code.symbols", null, { evidenceIds: [] }],
    ["a dependency version", "detections.dependencies", null, { versionConstraint: "^9.9.9" }],
    ["a dependency's directness", "detections.dependencies", null, { direct: false }],
    ["a detector's confidence", "detections.dependencies", null, { confidence: "high" }],
  ];

  for (const [label, kind, idFrom, fields] of cases) {
    test(`rejects an attempt to set ${label}`, () => {
      const entry = [...snapshot.records.values()].find((e) => e.kind === kind);
      assert.ok(entry, `fixture produced no ${kind} record`);
      const targetId = idFrom ? idFrom(entry.id) : entry.id;
      const result = validateAnnotations(
        sliceWith([{ targetId, basis: "inferred", fields }]), snapshot);
      assert.equal(result.valid, false);
      assert.ok(codesOf(result).includes("protected-field"), JSON.stringify(result.violations));
    });
  }

  test("rejects a protected field even when the value is correct", () => {
    // Absent, not merely unchanged: accepting a correct value would mean diffing model
    // output against static facts on every field forever.
    const entry = [...snapshot.records.values()].find((e) => e.kind === "code.symbols");
    const result = validateAnnotations(sliceWith([{
      targetId: entry.id, basis: "inferred",
      fields: { lineStart: entry.protected.lineStart },
    }]), snapshot);
    assert.equal(result.valid, false);
    assert.ok(codesOf(result).includes("protected-field"));
  });

  test("rejects a call endpoint rewrite", () => {
    const call = [...snapshot.records.values()].find((e) => e.kind === "code.calls");
    assert.ok(call, "fixture produced no call edges");
    const result = validateAnnotations(sliceWith([{
      targetId: call.id, basis: "inferred", fields: { calleeSymbolId: "sym.attacker" },
    }]), snapshot);
    assert.equal(result.valid, false);
    assert.ok(codesOf(result).includes("protected-field"));
  });

  test("reports every violation at once rather than only the first", () => {
    const entry = [...snapshot.records.values()].find((e) => e.kind === "inventory.files");
    const result = validateAnnotations(sliceWith([{
      targetId: entry.id, basis: "inferred",
      fields: { path: "x", sha256: "y", bytes: 0 },
    }]), snapshot);
    assert.equal(result.violations.filter((v) => v.code === "protected-field").length, 3);
  });
});

describe("enrichment is accepted", () => {
  test("a well-formed annotation validates and merges", () => {
    const symbol = [...snapshot.records.values()].find((e) => e.kind === "code.symbols");
    const slice = sliceWith([{
      targetId: symbol.id, basis: "observed",
      evidenceIds: symbol.protected.evidenceIds.slice(0, 1),
      fields: { summary: "Opens a connection for the given url.", componentId: "c.store" },
    }]);
    const result = validateAnnotations(slice, snapshot);
    assert.equal(result.valid, true, JSON.stringify(result.violations));

    const { merged } = mergeAnnotations(document, [slice], snapshot);
    const record = merged.get(symbol.id);
    assert.equal(record.semantic.summary, "Opens a connection for the given url.");
    assert.equal(record.lineStart, symbol.protected.lineStart, "the static core survives the join");
    assert.equal(record.name, symbol.protected.name);
  });

  test("semantic values live under their own key and cannot shadow a static one", () => {
    const symbol = [...snapshot.records.values()].find((e) => e.kind === "code.symbols");
    const slice = sliceWith([{
      targetId: symbol.id, basis: "inferred", fields: { summary: "s" },
    }]);
    const { merged } = mergeAnnotations(document, [slice], snapshot);
    const record = merged.get(symbol.id);
    assert.ok(Object.hasOwn(record, "semantic"));
    assert.equal(record.semantic.summary, "s");
    assert.equal(record.summary, undefined, "enrichment is never spread beside static fields");
  });

  test("merge records which slice contributed each field and on what basis", () => {
    const symbol = [...snapshot.records.values()].find((e) => e.kind === "code.symbols");
    const slice = sliceWith([{
      targetId: symbol.id, basis: "documented", fields: { summary: "from the readme" },
    }]);
    const { merged } = mergeAnnotations(document, [slice], snapshot);
    const provenance = merged.get(symbol.id).semanticProvenance.summary;
    assert.equal(provenance.sliceId, "foundation");
    assert.equal(provenance.basis, "documented");
  });
});

describe("grounding rules", () => {
  test("observed basis requires evidence", () => {
    const symbol = [...snapshot.records.values()].find((e) => e.kind === "code.symbols");
    const result = validateAnnotations(sliceWith([{
      targetId: symbol.id, basis: "observed", evidenceIds: [], fields: { summary: "s" },
    }]), snapshot);
    assert.ok(codesOf(result).includes("observed-without-evidence"));
  });

  test("cited evidence must exist in this run", () => {
    const symbol = [...snapshot.records.values()].find((e) => e.kind === "code.symbols");
    const result = validateAnnotations(sliceWith([{
      targetId: symbol.id, basis: "observed", evidenceIds: ["ev.invented.deadbeef"],
      fields: { summary: "s" },
    }]), snapshot);
    assert.ok(codesOf(result).includes("unresolved-evidence"));
  });

  test("basis must be one of the permitted values", () => {
    const symbol = [...snapshot.records.values()].find((e) => e.kind === "code.symbols");
    const result = validateAnnotations(sliceWith([{
      targetId: symbol.id, basis: "certain", fields: { summary: "s" },
    }]), snapshot);
    assert.ok(codesOf(result).includes("bad-basis"));
  });

  test("verification status may not be claimed during analysis", () => {
    const symbol = [...snapshot.records.values()].find((e) => e.kind === "code.symbols");
    const result = validateAnnotations(sliceWith([{
      targetId: symbol.id, basis: "inferred", verificationStatus: "verified",
      fields: { summary: "s" },
    }]), snapshot);
    assert.ok(codesOf(result).includes("premature-verification"));
  });
});

describe("run binding", () => {
  test("a slice analyzed against another artifact is refused", () => {
    const result = validateAnnotations(
      { ...sliceWith([]), artifactId: "artifact.somethingelse" }, snapshot);
    assert.ok(codesOf(result).includes("artifact-mismatch"));
  });

  test("a slice analyzed against another tree is refused", () => {
    const result = validateAnnotations(
      { ...sliceWith([]), treeFingerprint: "0".repeat(64) }, snapshot);
    assert.ok(codesOf(result).includes("fingerprint-mismatch"));
  });

  test("annotating a record from another run is refused", () => {
    const result = validateAnnotations(
      sliceWith([{ targetId: "sym.not.in.this.run", basis: "inferred", fields: { summary: "s" } }]),
      snapshot);
    assert.ok(codesOf(result).includes("unknown-target"));
  });

  test("evidence cannot be annotated, only cited", () => {
    const evidence = [...snapshot.records.values()].find((e) => e.kind === "evidence");
    const result = validateAnnotations(sliceWith([{
      targetId: evidence.id, basis: "inferred", fields: { detail: "rewritten" },
    }]), snapshot);
    assert.ok(codesOf(result).includes("unannotatable-kind"));
  });
});

describe("prose hygiene", () => {
  test("a host-absolute path in prose is refused", () => {
    const symbol = [...snapshot.records.values()].find((e) => e.kind === "code.symbols");
    const result = validateAnnotations(sliceWith([{
      targetId: symbol.id, basis: "inferred",
      fields: { summary: "defined in /Users/someone/work/repo/src/store.ts" },
    }]), snapshot);
    assert.ok(codesOf(result).includes("host-path-in-prose"));
  });

  test("a source-cache identifier in prose is refused", () => {
    const symbol = [...snapshot.records.values()].find((e) => e.kind === "code.symbols");
    const result = validateAnnotations(sliceWith([{
      targetId: symbol.id, basis: "inferred",
      fields: { summary: "see chunk.2b3ecf08e76205f3 for the body" },
    }]), snapshot);
    assert.ok(codesOf(result).includes("cache-id-in-prose"));
  });

  test("an ordinary repository-relative mention is fine", () => {
    const symbol = [...snapshot.records.values()].find((e) => e.kind === "code.symbols");
    const result = validateAnnotations(sliceWith([{
      targetId: symbol.id, basis: "inferred",
      fields: { summary: "declared in src/store.ts alongside loadUser" },
    }]), snapshot);
    assert.equal(result.valid, true, JSON.stringify(result.violations));
  });
});

describe("new entities", () => {
  test("a new entity id must be stable-ID compliant", () => {
    const result = validateAnnotations(
      sliceWith([], { entities: [{ id: "Component One!" }] }), snapshot);
    assert.ok(codesOf(result).includes("bad-entity-id"));
  });

  test("a new entity may not reuse a static record id", () => {
    const symbol = [...snapshot.records.values()].find((e) => e.kind === "code.symbols");
    const result = validateAnnotations(
      sliceWith([], { entities: [{ id: symbol.id }] }), snapshot);
    assert.ok(codesOf(result).includes("entity-id-collision"));
  });

  test("a fresh, well-formed entity id is accepted", () => {
    const result = validateAnnotations(
      sliceWith([], { entities: [{ id: "component.storage-layer" }] }), snapshot);
    assert.equal(result.valid, true, JSON.stringify(result.violations));
  });
});

describe("conflicts between slices", () => {
  test("two slices disagreeing on one field is recorded, not resolved by order", () => {
    const symbol = [...snapshot.records.values()].find((e) => e.kind === "code.symbols");
    const a = sliceWith([{ targetId: symbol.id, basis: "inferred", fields: { summary: "first" } }]);
    const b = { ...sliceWith([{ targetId: symbol.id, basis: "inferred", fields: { summary: "second" } }]),
      sliceId: "behavior" };

    const { merged, conflicts } = mergeAnnotations(document, [a, b], snapshot);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].field, "summary");
    assert.deepEqual(conflicts[0].values.map((v) => v.sliceId), ["foundation", "behavior"]);
    assert.equal(merged.get(symbol.id).semantic.summary, "first",
      "the first value is kept and the disagreement is surfaced, never silently overwritten");
  });

  test("two slices agreeing on one field is not a conflict", () => {
    const symbol = [...snapshot.records.values()].find((e) => e.kind === "code.symbols");
    const a = sliceWith([{ targetId: symbol.id, basis: "inferred", fields: { summary: "same" } }]);
    const b = { ...a, sliceId: "behavior" };
    const { conflicts } = mergeAnnotations(document, [a, b], snapshot);
    assert.equal(conflicts.length, 0);
  });

  test("slices contributing different fields merge cleanly", () => {
    const symbol = [...snapshot.records.values()].find((e) => e.kind === "code.symbols");
    const a = sliceWith([{ targetId: symbol.id, basis: "inferred", fields: { summary: "s" } }]);
    const b = { ...sliceWith([{ targetId: symbol.id, basis: "inferred", fields: { componentId: "c.x" } }]),
      sliceId: "behavior" };
    const { merged, conflicts } = mergeAnnotations(document, [a, b], snapshot);
    assert.equal(conflicts.length, 0);
    assert.equal(merged.get(symbol.id).semantic.summary, "s");
    assert.equal(merged.get(symbol.id).semantic.componentId, "c.x");
  });
});

describe("snapshot integrity", () => {
  test("the snapshot is taken before analysis and cannot be edited by it", () => {
    const entry = [...snapshot.records.values()][0];
    assert.throws(() => { entry.protected.path = "hijacked"; });
  });

  test("every static record is addressable in the snapshot", () => {
    assert.equal(snapshot.records.size,
      document.inventory.files.length + document.code.symbols.length +
      document.code.calls.length + document.evidence.length +
      Object.values(document.detections).reduce((n, c) => n + c.length, 0));
  });
});
