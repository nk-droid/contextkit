/**
 * Evaluation-corpus tests.
 *
 * Phase 3's exit criterion is that "reviewed manifest, command, and workflow
 * expectations pass for the first evaluation repositories". The word doing the work is
 * *reviewed*: each fixture carries expectations somebody derived by reading it, not a
 * snapshot of whatever the scanner happened to emit. A recorded snapshot passes forever
 * and proves nothing, because a regression simply rewrites it.
 *
 * Each fixture declares facts that must be present and facts that must be absent. The
 * absent list is the more valuable half - it encodes every false positive found so far,
 * and false positives are the failure that survives review.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { scanRepository } from "../src/analysis/scan-repository.mjs";
import { validateStaticDocument } from "../src/analysis/validation/validate-static.mjs";
import { compareRuns } from "../src/analysis/validation/determinism.mjs";
import { repository as nextDrizzleApp } from "./fixtures/repositories/next-drizzle-app.mjs";
import { repository as fastapiService } from "./fixtures/repositories/fastapi-service.mjs";
import { repository as sampleHeavy } from "./fixtures/repositories/sample-heavy.mjs";

const CORPUS = [nextDrizzleApp, fastapiService, sampleHeavy];

let workspace;
const scans = new Map();

/** Materialize a fixture on disk and scan it once. */
function materialize(repository) {
  const root = path.join(workspace, repository.name);
  for (const [rel, content] of Object.entries(repository.files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const namesIn = (document, collection) =>
  (document.detections[collection] ?? []).map((r) => r.pathOrName ?? r.name).filter(Boolean);

before(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ck-corpus-"));
  for (const repository of CORPUS) {
    const root = materialize(repository);
    scans.set(repository.name, { root, ...scanRepository(root) });
  }
});

after(() => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
});

for (const repository of CORPUS) {
  describe(`corpus: ${repository.name}`, () => {
    const documentOf = () => scans.get(repository.name).document;

    test("produces a structurally valid artifact", () => {
      const result = validateStaticDocument(documentOf());
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    });

    test("scans deterministically", () => {
      const { root } = scans.get(repository.name);
      const again = scanRepository(root).document;
      const result = compareRuns(documentOf(), again);
      assert.equal(result.deterministic, true,
        `nondeterministic: ${result.unexpectedDifferences.join(", ")}`);
    });

    for (const [collection, rule] of Object.entries(repository.expect)) {
      if (collection === "symbols" || collection === "calls") continue;

      test(`${collection}: reviewed expectations hold`, () => {
        const document = documentOf();
        const found = collection === "migrations"
          ? (document.detections.migrations ?? []).map((m) => m.path)
          : namesIn(document, collection);

        for (const expected of rule.present ?? []) {
          assert.ok(found.includes(expected),
            `expected ${collection} to include ${expected}; found ${JSON.stringify(found)}`);
        }
        for (const forbidden of rule.absent ?? []) {
          assert.ok(!found.includes(forbidden),
            `${collection} must not include ${forbidden}; found ${JSON.stringify(found)}`);
        }
        if (rule.presentAny) {
          assert.ok(rule.presentAny.some((name) => found.some((f) => f.includes(name))),
            `expected one of ${JSON.stringify(rule.presentAny)}; found ${JSON.stringify(found)}`);
        }
        if (Number.isInteger(rule.count)) assert.equal(found.length, rule.count);
        if (Number.isInteger(rule.minimum)) assert.ok(found.length >= rule.minimum);

        // `present: []` is a claim that the collection is empty, not an empty check.
        if (Array.isArray(rule.present) && rule.present.length === 0 && !rule.presentAny) {
          assert.deepEqual(found, [],
            `${collection} should be empty; found ${JSON.stringify(found)}`);
        }
      });
    }

    if (repository.expect.symbols) {
      test("declares the expected symbols", () => {
        const names = documentOf().code.symbols.map((s) => s.name);
        for (const expected of repository.expect.symbols.present) {
          assert.ok(names.includes(expected),
            `expected symbol ${expected}; found ${JSON.stringify(names)}`);
        }
      });
    }

    if (repository.expect.calls) {
      test("resolves the expected call edges", () => {
        const document = documentOf();
        const byId = new Map(document.code.symbols.map((s) => [s.id, s.name]));
        const edges = document.code.calls.map(
          (c) => `${byId.get(c.callerSymbolId)}->${byId.get(c.calleeSymbolId)}`);
        for (const [caller, callee] of repository.expect.calls.present) {
          assert.ok(edges.includes(`${caller}->${callee}`),
            `expected call ${caller}->${callee}; found ${JSON.stringify(edges)}`);
        }
      });
    }
  });
}

describe("corpus coverage", () => {
  test("covers both supported languages and an adversarial case", () => {
    const languages = new Set();
    for (const { document } of scans.values()) {
      for (const entry of document.inventory.languages ?? []) {
        languages.add(entry.language);
      }
    }
    assert.ok(languages.has("TypeScript"), `saw ${[...languages]}`);
    assert.ok(languages.has("Python"), `saw ${[...languages]}`);
    assert.ok(CORPUS.some((r) => Object.values(r.expect).some((e) => (e.absent ?? []).length > 2)),
      "at least one fixture exists to catch false positives");
  });

  test("fixture definitions do not pollute ContextKit's own scan", () => {
    // The fixtures live in template literals precisely so the masking rules exclude
    // them. If that stops being true, ContextKit starts reporting fixture routes as its
    // own, which is the bug this corpus exists to prevent.
    const self = scanRepository(process.cwd()).document;
    const routes = (self.detections.routes ?? []).map((r) => r.pathOrName);
    for (const ghost of ["/from-a-builder", "/documented-only", "/stripe", "/api/orders"]) {
      assert.ok(!routes.includes(ghost), `fixture route ${ghost} leaked into the self-scan`);
    }
  });
});
