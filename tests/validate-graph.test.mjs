import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeRelativePath, validateGraphDocument } from "../scripts/validate-graph.mjs";

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts");

function validDocument() {
  return {
    schemaVersion: 1,
    repository: { id: "sample", name: "Sample", source: "/work/sample" },
    graphs: [
      {
        id: "architecture",
        kind: "architecture",
        title: "Architecture",
        description: "A minimal synthetic graph used only by this test.",
        nodes: [
          {
            id: "cli",
            label: "CLI",
            kind: "entrypoint",
            summary: "Starts the application.",
            basis: "observed",
            evidence: [{ path: "bin/tool" }],
          },
          {
            id: "service",
            label: "Service",
            kind: "module",
            summary: "Performs work.",
            basis: "inferred",
            evidence: [],
          },
        ],
        edges: [
          {
            id: "cli-service",
            source: "cli",
            target: "service",
            kind: "calls",
            label: "calls",
            basis: "inferred",
            evidence: [],
          },
        ],
      },
    ],
    warnings: [],
  };
}

test("accepts a structurally valid graph", () => {
  assert.deepEqual(validateGraphDocument(validDocument()), []);
});

test("rejects unsafe paths", () => {
  assert.equal(safeRelativePath("../secret"), false);
  assert.equal(safeRelativePath("/etc/passwd"), false);
  assert.equal(safeRelativePath("src/index.ts"), true);
});

test("rejects dangling edges and missing observed evidence", () => {
  const document = validDocument();
  document.graphs[0].nodes[0].evidence = [];
  document.graphs[0].edges[0].target = "missing";
  const errors = validateGraphDocument(document);
  assert.ok(errors.some((error) => error.includes("observed items require evidence")));
  assert.ok(errors.some((error) => error.includes("unknown node missing")));
});

test("rejects duplicate identifiers", () => {
  const document = validDocument();
  document.graphs[0].nodes.push({ ...document.graphs[0].nodes[1] });
  const errors = validateGraphDocument(document);
  assert.ok(errors.some((error) => error.includes("duplicate node id service")));
});

test("still validates when run through a symlink, as an installed skill is", () => {
  const root = mkdtempSync(join(tmpdir(), "contextkit-validator-link-"));
  try {
    symlinkSync(scriptsDir, join(root, "linked"));
    const graph = join(root, "graph.json");
    writeFileSync(graph, JSON.stringify({ schemaVersion: 2 }));
    const result = spawnSync(process.execPath, [join(root, "linked", "validate-graph.mjs"), graph], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /schemaVersion: expected 1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
