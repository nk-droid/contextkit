/**
 * Run workspace tests (plan §6.2).
 *
 * One run, one directory - which makes the directory valuable, and makes anything that
 * rewrites it dangerous. A run holds slice responses, frozen registries, and run reports
 * that cost real time and money to produce; the scan artifacts beside them are
 * reproducible for free. These tests exist because an early version had that backwards
 * and replaced the directory wholesale on every scan.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { RunWorkspace, ensureRunWorkspace, runIdFor } from "../src/analysis/run-workspace.mjs";

describe("a rescan does not destroy prior analysis", () => {
  // The run id is the tree fingerprint, so re-scanning an unchanged tree produces
  // byte-identical artifacts. Replacing the directory would delete slice responses and
  // frozen registries to rewrite two files that did not change.
  let repo;
  let workRoot;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ck-rescan-repo-"));
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ck-rescan-work-"));
    fs.writeFileSync(path.join(repo, "package.json"), '{"name":"rescan","version":"1.0.0"}');
    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src/main.ts"), "export function main() { return 1; }\n");
  });

  after(() => {
    for (const d of [repo, workRoot]) if (d) fs.rmSync(d, { recursive: true, force: true });
  });

  test("keeps slice responses, registries, and reports across a rescan", () => {
    const first = ensureRunWorkspace(repo, { workRoot }).workspace;

    // Stand in for expensive prior work.
    first.writeSliceArtifact(1, "foundation", "claude", "response", { result: { kept: true } });
    fs.writeFileSync(path.join(first.dir, "ENTITY_REGISTRY.json"), '{"entityIds":["component.a"]}');
    fs.writeFileSync(first.runReportPath, '{"providers":[]}');

    const second = ensureRunWorkspace(repo, { workRoot }).workspace;
    assert.equal(second.dir, first.dir, "an unchanged tree is the same run");

    const survivors = second.describe().map((e) => e.path);
    assert.ok(survivors.includes("ENTITY_REGISTRY.json"), `lost the registry; have ${survivors}`);
    assert.ok(survivors.includes("run-report.json"), `lost the run report; have ${survivors}`);
    assert.ok(survivors.some((p) => p.endsWith("01-foundation.claude.response.json")),
      `lost the slice response; have ${survivors}`);

    const kept = JSON.parse(fs.readFileSync(
      second.slicePath(1, "foundation", "claude", "response"), "utf8"));
    assert.equal(kept.result.kept, true, "the response was replaced rather than preserved");
  });

  test("the scan artifacts are still present and current", () => {
    const workspace = ensureRunWorkspace(repo, { workRoot }).workspace;
    assert.ok(fs.existsSync(workspace.staticPath));
    assert.ok(fs.existsSync(workspace.sourceIndexPath));
    const document = JSON.parse(fs.readFileSync(workspace.staticPath, "utf8"));
    assert.equal(document.repository.name, path.basename(repo));
  });

  test("a changed tree becomes a different run, leaving the old one intact", () => {
    const before = ensureRunWorkspace(repo, { workRoot }).workspace;
    fs.writeFileSync(path.join(repo, "src/extra.ts"), "export function extra() { return 2; }\n");
    try {
      const after = ensureRunWorkspace(repo, { workRoot }).workspace;
      assert.notEqual(after.dir, before.dir, "a different tree must not reuse the run directory");
      assert.ok(fs.existsSync(before.staticPath), "the previous run must survive");
    } finally {
      fs.rmSync(path.join(repo, "src/extra.ts"));
    }
  });
});

describe("layout", () => {
  test("every artifact the plan names has a single defined path", () => {
    const workspace = new RunWorkspace("/tmp/run_abc");
    const paths = {
      static: workspace.staticPath,
      sourceIndex: workspace.sourceIndexPath,
      analysisPlan: workspace.analysisPlanPath,
      semantic: workspace.semanticPath,
      candidate: workspace.candidatePath,
      validationReport: workspace.validationReportPath,
      runReport: workspace.runReportPath,
    };
    for (const [name, value] of Object.entries(paths)) {
      assert.ok(value.startsWith("/tmp/run_abc/"), `${name} escaped the run directory`);
    }
    assert.equal(new Set(Object.values(paths)).size, Object.keys(paths).length,
      "two artifacts share a path");
  });

  test("slice artifacts are named per provider, so a comparison cannot overwrite itself", () => {
    const workspace = new RunWorkspace("/tmp/run_abc");
    const claude = workspace.slicePath(1, "foundation", "claude", "response");
    const codex = workspace.slicePath(1, "foundation", "codex", "response");
    assert.notEqual(claude, codex);
    assert.ok(claude.endsWith("analysis/01-foundation.claude.response.json"));
  });

  test("the run id is derived from the tree, not from the clock", () => {
    const fingerprint = "a".repeat(64);
    assert.equal(runIdFor(fingerprint), runIdFor(fingerprint));
    assert.notEqual(runIdFor(fingerprint), runIdFor("b".repeat(64)));
    assert.match(runIdFor(fingerprint), /^run_[0-9a-f]{16}$/);
  });

  test("the provider sandbox is never inside the run directory", () => {
    // A sandbox under the run directory could reach the source cache with `../..`,
    // bypassing every access control in the MCP layer.
    const workspace = new RunWorkspace(fs.mkdtempSync(path.join(os.tmpdir(), "ck-layout-")));
    const sandbox = workspace.createProviderSandbox("probe");
    try {
      assert.ok(path.relative(workspace.dir, sandbox).startsWith(".."),
        "the sandbox must not share a parent with the source cache");
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
      fs.rmSync(workspace.dir, { recursive: true, force: true });
    }
  });
});
