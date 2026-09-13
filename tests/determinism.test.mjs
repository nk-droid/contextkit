/**
 * Determinism tests - Phase 1's exit criterion, enforced rather than asserted.
 *
 * The criterion is that repeated scans of the same snapshot produce identical normalized
 * output. The traps here are worth naming, because a determinism test is easy to write
 * so that it cannot fail: normalize too much and every run matches; compare only a hash
 * and a real regression reads as an unexplained mismatch. So these tests check that the
 * *only* differences are the declared volatile ones, and separately check that the
 * comparison can still detect a planted change.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { scanRepository } from "../src/analysis/scan-repository.mjs";
import {
  VOLATILE_FIELDS, compareRuns, diffDocuments, generalizePath, normalizeDocument,
} from "../src/analysis/validation/determinism.mjs";

let fixture;

function write(rel, content) {
  const full = path.join(fixture, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ck-determinism-"));
  write("package.json", JSON.stringify({
    name: "determinism-fixture", version: "2.1.0",
    scripts: { build: "tsc", test: "node --test" },
    dependencies: { zod: "^3.0.0" }, devDependencies: { typescript: "^5.0.0" },
  }, null, 2));
  write("Makefile", "run:\n\tnode server.mjs\n");
  write("README.md", "# Fixture\n\nA repository used to check reproducibility.\n");
  write("src/store.ts", [
    "export class Store {",
    "  connect(url) { return url; }",
    "}",
    "",
    "export function loadUser(id) {",
    "  return new Store().connect(id);",
    "}",
    "",
  ].join("\n"));
  write("src/worker.py", [
    "def handle(event):",
    "    return transform(event)",
    "",
    "def transform(value):",
    "    return value",
    "",
  ].join("\n"));
  write("src/app/api/users/route.ts", "export function GET() { return 1; }\n");
});

after(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

describe("repeated scans of one snapshot", () => {
  test("differ only in the declared volatile fields", () => {
    const first = scanRepository(fixture).document;
    const second = scanRepository(fixture).document;
    const result = compareRuns(first, second);
    assert.equal(result.deterministic, true,
      `nondeterministic fields: ${result.unexpectedDifferences.join(", ")}`);
  });

  test("produce byte-identical normalized documents", () => {
    const first = normalizeDocument(scanRepository(fixture).document);
    const second = normalizeDocument(scanRepository(fixture).document);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  test("produce a byte-identical source index", () => {
    const first = scanRepository(fixture).sourceIndex;
    const second = scanRepository(fixture).sourceIndex;
    assert.equal(first.jsonl, second.jsonl);
    assert.equal(first.summary.sha256, second.summary.sha256);
  });

  test("produce the same tree fingerprint and artifact id", () => {
    const first = scanRepository(fixture).document;
    const second = scanRepository(fixture).document;
    assert.equal(first.repository.treeFingerprint, second.repository.treeFingerprint);
    assert.equal(first.artifactId, second.artifactId);
  });
});

describe("the comparison can actually fail", () => {
  // Without these, every test above would still pass if normalizeDocument stripped the
  // whole document.
  test("detects a planted change to a fact", () => {
    const first = scanRepository(fixture).document;
    const second = JSON.parse(JSON.stringify(first));
    second.inventory.files[0].sha256 = "0".repeat(64);
    const result = compareRuns(first, second);
    assert.equal(result.deterministic, false);
    assert.deepEqual(result.unexpectedDifferences, ["inventory.files[].sha256"]);
  });

  test("detects an added or removed record", () => {
    const first = scanRepository(fixture).document;
    const second = JSON.parse(JSON.stringify(first));
    second.code.symbols.pop();
    assert.equal(compareRuns(first, second).deterministic, false);
  });

  test("detects reordering, which is a determinism bug even with the same contents", () => {
    const first = scanRepository(fixture).document;
    const second = JSON.parse(JSON.stringify(first));
    second.inventory.files.reverse();
    assert.equal(compareRuns(first, second).deterministic, false);
  });

  test("normalization removes the volatile fields and nothing else", () => {
    const document = scanRepository(fixture).document;
    const normalized = normalizeDocument(document);
    const removed = diffDocuments(document, normalized).map(generalizePath);
    assert.deepEqual([...new Set(removed)].sort(), [...VOLATILE_FIELDS].sort());
  });

  test("timing differences are reported as volatile, not as regressions", () => {
    const first = scanRepository(fixture).document;
    const second = JSON.parse(JSON.stringify(first));
    second.scanner.durationMs += 1;
    second.scanner.extractors[0].durationMs += 1;
    const result = compareRuns(first, second);
    assert.equal(result.deterministic, true);
    assert.deepEqual(result.volatileDifferences,
      ["scanner.durationMs", "scanner.extractors[].durationMs"]);
  });
});

describe("what identity depends on", () => {
  test("a touched mtime does not change any output", () => {
    const first = scanRepository(fixture).document;
    const target = path.join(fixture, "src/store.ts");
    const future = new Date(Date.now() + 86_400_000);
    fs.utimesSync(target, future, future);
    const second = scanRepository(fixture).document;
    assert.equal(compareRuns(first, second).deterministic, true,
      "identity must be content-derived, never stat-derived");
    assert.equal(first.repository.treeFingerprint, second.repository.treeFingerprint);
  });

  test("a content change moves the fingerprint and the affected records", () => {
    const before = scanRepository(fixture).document;
    const target = path.join(fixture, "src/store.ts");
    const original = fs.readFileSync(target, "utf8");
    fs.writeFileSync(target, `${original}\nexport function added() { return 2; }\n`);
    try {
      const after_ = scanRepository(fixture).document;
      assert.notEqual(before.repository.treeFingerprint, after_.repository.treeFingerprint);
      assert.equal(compareRuns(before, after_).deterministic, false);
    } finally {
      fs.writeFileSync(target, original);
    }
  });

  test("identical content at two paths produces distinct ids", () => {
    const body = "export function twin() { return 1; }\n";
    write("src/a-twin.ts", body);
    write("src/b-twin.ts", body);
    try {
      const document = scanRepository(fixture).document;
      const twins = document.code.symbols.filter((s) => s.name === "twin");
      assert.equal(twins.length, 2, "both declarations are retained");
      assert.notEqual(twins[0].id, twins[1].id, "ids incorporate the path, not only the body");
    } finally {
      fs.rmSync(path.join(fixture, "src/a-twin.ts"));
      fs.rmSync(path.join(fixture, "src/b-twin.ts"));
    }
  });

  test("the same snapshot scanned from a different directory is identical", () => {
    // A copy at another path must produce the same facts, or the artifact is tied to
    // where it happened to be scanned.
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "ck-determinism-copy-"));
    try {
      fs.cpSync(fixture, copy, { recursive: true });
      const a = normalizeDocument(scanRepository(fixture).document);
      const b = normalizeDocument(scanRepository(copy).document);
      const differences = diffDocuments(a, b).map(generalizePath);
      const ignorable = new Set(["repository.name", "repository.id", "artifactId"]);
      const unexpected = [...new Set(differences)].filter((p) => !ignorable.has(p));
      assert.deepEqual(unexpected, [],
        "only the repository's own name may depend on where it sits");
      assert.equal(a.repository.treeFingerprint, b.repository.treeFingerprint);
    } finally {
      fs.rmSync(copy, { recursive: true, force: true });
    }
  });
});
