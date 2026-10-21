import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { test, after } from "node:test";
import ts from "typescript";
import { RunWorkspace, ensureRunWorkspace } from "../src/analysis/run-workspace.mjs";
import { RunStore } from "../src/analysis/mcp/run-store.mjs";
import { buildProtectedSnapshot } from "../src/analysis/merge/protected-fields.mjs";
import { SLICES } from "../src/analysis/slices/plan-slices.mjs";
import { validateSliceResult } from "../src/analysis/slices/slice-kit.mjs";
import { resultHash, checkCachedSlice } from "../src/analysis/slices/cache.mjs";
import { assembleNetwork, ownerFor, publishNetwork } from "../src/network/assemble.mjs";
import { parseNetworkFacts } from "../src/network/schema.mjs";
import { toCodexSchema, decodeCodexResult } from "../scripts/codex-schema.mjs";
import { ContextKitMcpServer } from "../src/analysis/mcp/server.mjs";
import { checkRequestedEvidence } from "../src/analysis/validation/requested-evidence.mjs";

const root = path.resolve(import.meta.dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-network-test-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function repository(name, files = {}) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "Fixture");
  return dir;
}
const repo = repository("typescript repo", {
  "src/api/main.ts": 'import { read } from "../storage/db"; export function main() { return read(); }\n',
  "src/storage/db.ts": 'export function read() { return 42; }\n',
  "README.md": "# Public test fixture\n",
});
const workspace = ensureRunWorkspace(repo, { workRoot: path.join(temp, "runs") }).workspace;
const facts = assembleNetwork(workspace, { sourceIdentity: repo });

function command(args) {
  return spawnSync(process.execPath, [path.join(root, "bin/contextkit-network"), ...args], { cwd: repo, encoding: "utf8" });
}

test("local Git repository exports nodes, calls and inferred ownership without touching source", () => {
  const output = path.join(temp, "local.json");
  const result = command([repo, "--output", output]);
  assert.equal(result.status, 0, result.stderr);
  const parsed = parseNetworkFacts(JSON.parse(fs.readFileSync(output)));
  assert.equal(parsed.code.symbols.length, 2);
  assert.ok(parsed.code.calls.some((c) => c.crossesComponent));
  assert.ok(parsed.architecture.relationships.length);
  assert.ok(parsed.coverage.missingLayers.includes("risk"));
  assert.equal(git(repo, "status", "--porcelain"), "");
});

test("Git URL acquisition scans a real cloned mirror and keeps stable identity across clones", () => {
  const input = pathToFileURL(repo).href;
  const outputs = [path.join(temp, "clone1.json"), path.join(temp, "clone2.json")];
  for (const output of outputs) {
    const result = command([input, "--output", output]);
    assert.equal(result.status, 0, result.stderr);
  }
  const [a, b] = outputs.map((f) => JSON.parse(fs.readFileSync(f)));
  assert.equal(a.repository.id, b.repository.id);
  assert.equal(a.repository.revision, git(repo, "rev-parse", "HEAD").trim());
  assert.equal(a.code.calls.length, facts.code.calls.length);
});

test("unsupported languages and empty repositories still yield explicit, importable directory networks", () => {
  for (const [name, files] of [["go-only", { "main.go": "package main\nfunc main() {}\n" }], ["empty", {}]]) {
    const source = repository(name, files);
    const output = path.join(temp, `${name}.json`);
    const result = command([source, "--output", output]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = parseNetworkFacts(JSON.parse(fs.readFileSync(output)));
    assert.ok(parsed.architecture.components.length);
    assert.equal(parsed.code.symbols.length, 0);
    if (name === "go-only") assert.ok(parsed.coverage.unsupportedLanguages.includes("Go"));
  }
});

test("untracked files are included only when requested", () => {
  fs.writeFileSync(path.join(repo, "extra.ts"), "export function extra() {}\n");
  try {
    for (const [flag, count] of [[[], 2], [["--allow-untracked"], 3]]) {
      const output = path.join(temp, `untracked-${count}.json`);
      const result = command([repo, "--output", output, ...flag]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(fs.readFileSync(output)).code.symbols.length, count);
    }
  } finally { fs.unlinkSync(path.join(repo, "extra.ts")); }
});

test("ownership chooses the most specific path and preserves ambiguity", () => {
  const components = [{ id: "root", paths: ["."] }, { id: "src", paths: ["src"] }, { id: "api", paths: ["src/api"] }];
  assert.equal(ownerFor("src/api/main.ts", components), "api");
  assert.equal(ownerFor("README.md", components), "root");
  assert.equal(ownerFor("src/api/main.ts", [...components, { id: "other", paths: ["src/api"] }]), null);
});

test("export rejects duplicate IDs, dangling links/evidence and inconsistent ownership, preserving prior file", () => {
  const output = path.join(temp, "atomic.json");
  publishNetwork(facts, output);
  const original = fs.readFileSync(output, "utf8");
  const mutations = [
    (d) => d.architecture.components.push(d.architecture.components[0]),
    (d) => d.architecture.relationships[0].targetId = "component.missing",
    (d) => d.code.symbols[0].grounding.evidenceIds.push("ev.missing"),
    (d) => d.code.calls[0].crossesComponent = !d.code.calls[0].crossesComponent,
    (d) => d.evidence[0].path = "../escape.ts",
    (d) => d.code.symbols[0].componentId = "component.missing",
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(facts);
    mutate(bad);
    assert.throws(() => publishNetwork(bad, output));
    assert.equal(fs.readFileSync(output, "utf8"), original);
  }
});

function semanticResults(baseFacts = facts) {
  const g = { basis: "inferred", confidence: "medium", evidenceIds: [], claimIds: [], notes: [] };
  const components = baseFacts.architecture.components.map((c) => ({ ...c,
    nonResponsibilities: [], entrypointIds: [], technologyIds: [], stateStoreIds: [], ownerHint: null, grounding: g,
  }));
  return {
    foundation: { primaryUsers: [], capabilities: [], nonGoals: [], repositoryRoles: [], styles: [], components, externalSystems: [], annotations: [] },
    "behavior-data": { relationships: [], runtimeFlows: [], boundaries: [], invariants: [], apiSurfaces: [], dataContracts: [], stores: [], entities: [], retentionRules: [], consistencyRules: [], annotations: [] },
  };
}

test("export-only projects scanner public interfaces without rerunning or rewriting semantic slices", () => {
  const source = repository("mixed-interfaces", {
    "Makefile": "scan:\n\tnode src/main.js\n",
    "package.json": JSON.stringify({ scripts: { start: "node src/main.js" } }),
    "src/main.js": "export function main() { return 1; }\n",
    "app/api/items/route.ts": "export function GET() { return []; }\n",
    "item.schema.json": JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { name: { type: "string" } } }),
  });
  const run = ensureRunWorkspace(source, { workRoot: path.join(temp, "interface-runs") }).workspace;
  const store = RunStore.fromDirectory(run.dir, { includeSourceIndex: false });
  const doc = store.document;
  const results = semanticResults(assembleNetwork(run));
  const consumer = results.foundation.components.find((c) => c.paths.includes("."));
  const owner = results.foundation.components.find((c) => c.paths.includes("app"));
  const refs = ["commands", "entrypoints", "apiSurfaces", "routes", "dataContracts"]
    .flatMap((kind) => {
      assert.ok(doc.detections[kind].length, `fixture must detect ${kind}`);
      return doc.detections[kind].map((r) => r.id);
    });
  assert.equal(doc.detections.commands.length, 2, "covers Makefile and npm commands");
  refs.push(doc.code.symbols[0].id);
  consumer.publicInterfaceIds = refs;
  owner.publicInterfaceIds = [doc.detections.apiSurfaces[0].id];
  const g = { basis: "inferred", confidence: "medium", evidenceIds: [], claimIds: [], notes: [] };
  results["behavior-data"].apiSurfaces = [{
    id: "surface.items", name: "Items API", kind: "http", basePathOrNamespace: "/api/items",
    stability: "internal", consumerEntityIds: [consumer.id], grounding: g,
    endpoints: [{
      id: "surface.items-get", method: "GET", pathOrName: "/api/items", purpose: "Lists items",
      auth: "unknown", requestShape: "none", responseShape: "array", errorBehavior: [],
      implementationPath: "app/api/items/route.ts", implementationSymbol: "GET", grounding: g,
    }],
  }];
  const writeResults = () => {
    for (const [id, result] of Object.entries(results)) {
      const slice = SLICES[id];
      run.writeSliceArtifact(slice.order, id, "codex", "response", { result, boundTo: {
        artifactId: doc.artifactId, treeFingerprint: doc.repository.treeFingerprint,
        contractVersion: slice.contractVersion, schemaHash: slice.schemaHash(),
        promptSetVersion: slice.promptSetVersion, sourceExposure: "static-only",
        foundationHash: id === "foundation" ? null : resultHash(results.foundation),
      } });
    }
  };
  writeResults();
  const responseFiles = Object.values(SLICES).map((s) => run.slicePath(s.order, s.id, "codex", "response"));
  const originalResponses = responseFiles.map((f) => fs.readFileSync(f, "utf8"));
  const output = path.join(temp, "mixed-interfaces.json");
  const invoke = () => spawnSync(process.execPath, [path.join(root, "bin/contextkit-export-network"), run.dir,
    "--provider", "codex", "--output", output], { cwd: temp, encoding: "utf8" });
  const exported = invoke();
  assert.equal(exported.status, 0, exported.stderr);
  const parsed = parseNetworkFacts(JSON.parse(fs.readFileSync(output)));
  assert.deepEqual(parsed.architecture.components.find((c) => c.id === consumer.id).publicInterfaceIds, []);
  assert.deepEqual(parsed.architecture.components.find((c) => c.id === owner.id).publicInterfaceIds, ["surface.items"]);
  for (const id of refs) assert.ok(parsed.warnings.some((w) => w.includes(id)), `projection must disclose omitted ${id}`);
  assert.deepEqual(responseFiles.map((f) => fs.readFileSync(f, "utf8")), originalResponses);
  const originalExport = fs.readFileSync(output, "utf8");
  // A matching prefix is not proof that a referenced scanner record exists.
  for (const unknown of ["cmd.makefile.missing", "ep.missing", "surface.missing"]) {
    consumer.publicInterfaceIds = [...refs, unknown];
    writeResults();
    const rejected = invoke();
    assert.notEqual(rejected.status, 0);
    assert.ok(rejected.stderr.includes(unknown), rejected.stderr);
    assert.equal(fs.readFileSync(output, "utf8"), originalExport);
  }
});

test("strict schema rejects empty and legacy results; schema hashes invalidate otherwise bound caches", () => {
  const store = RunStore.fromDirectory(workspace.dir);
  const snapshot = buildProtectedSnapshot(store.document);
  for (const slice of Object.values(SLICES)) {
    assert.equal(validateSliceResult({}, slice, { store, snapshot }).valid, false);
  }
  const slice = SLICES.foundation;
  const result = semanticResults().foundation;
  const envelope = { result, boundTo: { artifactId: snapshot.artifactId, treeFingerprint: snapshot.treeFingerprint, contractVersion: slice.contractVersion, schemaHash: slice.schemaHash(), promptSetVersion: slice.promptSetVersion } };
  assert.equal(checkCachedSlice(envelope, slice, { store, snapshot }).valid, true);
  envelope.boundTo.schemaHash = "old";
  assert.ok(checkCachedSlice(envelope, slice, { store, snapshot }).errors.some((e) => e.code === "stale-contract"));
});

test("semantic export projects store, API and contract references onto architecture nodes", async () => {
  const dir = path.join(temp, "semantic-reference-projection");
  fs.mkdirSync(dir);
  fs.copyFileSync(workspace.staticPath, path.join(dir, "STATIC_ANALYSIS.json"));
  const run = new RunWorkspace(dir);
  const doc = JSON.parse(fs.readFileSync(run.staticPath));
  const results = semanticResults();
  const behavior = results["behavior-data"];
  const componentId = results.foundation.components[0].id;
  const g = { basis: "inferred", confidence: "medium", evidenceIds: [], claimIds: [], notes: [] };
  results.foundation.externalSystems = [{ id: "external.client", name: "Client", kind: "service", purpose: "Caller", protocols: [], required: false, grounding: g }];
  behavior.entities = [{
    id: "entity.document", name: "Document", storeId: "store.documents", purpose: "Indexed document",
    definitionPaths: ["src/storage/db.ts"], keyFields: [], lifecycle: "In memory", sensitiveFields: [], grounding: g,
  }];
  const omitted = ["entity.document", doc.code.symbols[0].id];
  behavior.stores = [{
    id: "store.documents", name: "Documents", kind: "memory", technologyId: null, purpose: "Stores documents",
    durability: "ephemeral", accessEntityIds: [componentId, "external.client", ...omitted],
    definitionPaths: ["src/storage/db.ts"], sensitiveData: [], grounding: g,
  }];
  behavior.apiSurfaces = [{
    id: "surface.documents", name: "Documents API", kind: "library", basePathOrNamespace: "documents",
    stability: "internal", consumerEntityIds: [componentId, "external.client", "store.documents", ...omitted],
    endpoints: [], grounding: g,
  }];
  behavior.dataContracts = [{
    id: "contract.document", name: "Document payload", kind: "object", definitionPaths: ["src/storage/db.ts"],
    producerEntityIds: [componentId, ...omitted], consumerEntityIds: ["external.client", "store.documents", ...omitted],
    compatibilityNotes: [], sensitiveFields: [], grounding: g,
  }];
  const writeResults = () => {
    for (const [id, result] of Object.entries(results)) {
      const slice = SLICES[id];
      run.writeSliceArtifact(slice.order, id, "codex", "response", { result, boundTo: {
        artifactId: doc.artifactId, treeFingerprint: doc.repository.treeFingerprint,
        contractVersion: slice.contractVersion, schemaHash: slice.schemaHash(), promptSetVersion: slice.promptSetVersion,
        foundationHash: id === "foundation" ? null : resultHash(results.foundation),
        sourceExposure: "static-only", requestedModel: null,
      } });
    }
  };
  writeResults();
  const responses = Object.values(SLICES).map(s => run.slicePath(s.order, s.id, "codex", "response"));
  const original = responses.map(f => fs.readFileSync(f, "utf8"));
  const output = path.join(temp, "semantic-reference-projection.json");
  const result = command([dir, "--provider", "codex", "--output", output]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reusing validated foundation/);
  assert.match(result.stdout, /Reusing validated behavior-data/);
  assert.deepEqual(responses.map(f => fs.readFileSync(f, "utf8")), original);
  const parsed = parseNetworkFacts(JSON.parse(fs.readFileSync(output)));
  assert.deepEqual(parsed.data.stores[0].accessEntityIds, [componentId, "external.client"]);
  assert.deepEqual(parsed.interfaces.apiSurfaces[0].consumerEntityIds, [componentId, "external.client", "store.documents"]);
  assert.deepEqual(parsed.interfaces.dataContracts[0].producerEntityIds, [componentId]);
  assert.deepEqual(parsed.interfaces.dataContracts[0].consumerEntityIds, ["external.client", "store.documents"]);
  for (const field of ["store.documents.accessEntityIds", "surface.documents.consumerEntityIds", "contract.document.producerEntityIds", "contract.document.consumerEntityIds"]) {
    assert.ok(parsed.warnings.some(w => w.includes(field) && omitted.every(id => w.includes(id))), field);
  }
  const source = fs.readFileSync(path.join(root, "web/app/facts/network.ts"), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { buildNetwork } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
  const model = buildNetwork(parsed);
  assert.ok(model.links.some(l => l.source === componentId && l.target === "store.documents"));
  for (const link of model.links) {
    assert.ok(model.nodeById.has(link.source));
    assert.ok(model.nodeById.has(link.target));
    assert.notEqual(link.source, "entity.document");
    assert.notEqual(link.target, "entity.document");
  }
  const goodExport = fs.readFileSync(output, "utf8");
  for (const [record, field] of [[behavior.stores[0], "accessEntityIds"], [behavior.apiSurfaces[0], "consumerEntityIds"],
    [behavior.dataContracts[0], "producerEntityIds"], [behavior.dataContracts[0], "consumerEntityIds"]]) {
    record[field].push("entity.missing");
    writeResults();
    assert.throws(() => publishNetwork(assembleNetwork(run, { provider: "codex" }), output), /entity.missing/);
    assert.equal(fs.readFileSync(output, "utf8"), goodExport);
    record[field].pop();
  }
  // An export error after valid slices should point to the local retry path.
  results.foundation.components[0].publicInterfaceIds = ["surface.missing"];
  writeResults();
  const failed = command([dir, "--provider", "codex", "--output", output]);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /Reusing validated behavior-data/);
  assert.match(failed.stderr, /Export failed; prior export preserved/);
  assert.match(failed.stderr, /contextkit-export-network/);
  assert.match(failed.stderr, /surface.missing/);
  assert.equal(fs.readFileSync(output, "utf8"), goodExport);
});

test("semantic assembly consumes validated slices and refuses stale downstream results", () => {
  const results = semanticResults();
  const doc = JSON.parse(fs.readFileSync(workspace.staticPath));
  for (const [id, result] of Object.entries(results)) {
    const slice = SLICES[id];
    workspace.writeSliceArtifact(slice.order, id, "claude", "response", { result, boundTo: {
      artifactId: doc.artifactId, treeFingerprint: doc.repository.treeFingerprint,
      contractVersion: slice.contractVersion, schemaHash: slice.schemaHash(),
      promptSetVersion: slice.promptSetVersion,
      foundationHash: id === "foundation" ? null : resultHash(results.foundation),
      sourceExposure: "static-only", requestedModel: null,
    } });
  }
  const parsed = assembleNetwork(workspace, { provider: "claude" });
  assert.equal(parsed.coverage.mode, "semantic");
  assert.deepEqual(parsed.coverage.completedSlices, ["foundation", "behavior-data"]);
  // The full command can resume without invoking a provider when both caches match.
  const output = path.join(temp, "semantic.json");
  const resumed = command([workspace.dir, "--provider", "claude", "--output", output]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Reusing validated foundation/);
  const firstFile = workspace.slicePath(1, "foundation", "claude", "response");
  const changed = JSON.parse(fs.readFileSync(firstFile));
  changed.result.components[0].summary = "Changed interpretation";
  fs.writeFileSync(firstFile, JSON.stringify(changed));
  assert.throws(() => assembleNetwork(workspace, { provider: "claude" }), /foundation changed/);
});

test("provider schema is closed, and annotation transport restores canonical dictionaries", () => {
  for (const slice of Object.values(SLICES)) {
    const schema = toCodexSchema(slice.loadSchema());
    function walk(n) {
      if (!n || typeof n !== "object") return;
      if (n.type === "object") {
        assert.equal(n.additionalProperties, false);
        assert.deepEqual(n.required, Object.keys(n.properties ?? {}));
      }
      Object.values(n).forEach(walk);
    }
    walk(schema);
  }
  assert.deepEqual(decodeCodexResult({ annotations: [{ fields: [{ key: "summary", value: "Known" }] }] }).annotations[0].fields, { summary: "Known" });
  assert.throws(() => decodeCodexResult({ annotations: [{ fields: [{ key: "x", value: "a" }, { key: "x", value: "b" }] }] }), /Duplicate/);
});

test("actual web graph builder and orb layout consume the exported artifact", async () => {
  const src = fs.readFileSync(path.join(root, "web/app/facts/network.ts"), "utf8");
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const url = "data:text/javascript;base64," + Buffer.from(js).toString("base64");
  const { buildNetwork } = await import(url);
  const model = buildNetwork(parseNetworkFacts(facts));
  assert.equal(model.nodes.length, facts.architecture.components.length + facts.code.symbols.length);
  assert.ok(model.links.some((l) => l.layer === "contains"));
  assert.ok(model.links.some((l) => l.layer === "cross"));
  const orb = ts.transpileModule(fs.readFileSync(path.join(root, "web/app/facts/orb.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace('"./network"', JSON.stringify(url));
  const { orbLayout } = await import("data:text/javascript;base64," + Buffer.from(orb).toString("base64"));
  const positions = orbLayout(model.nodes, model.links);
  assert.ok(positions);
});

test("bad options and bad URLs fail with a clear error before publishing", () => {
  for (const args of [[repo, "--provider", "typo"], [repo, "--output"], [repo, "--timeout-seconds", "NaN"], [repo, "--max-turns", "0"], ["https://user:password@example.test/repo"], ["ext://bad"]]) {
    const result = command(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /contextkit network:/);
  }
});

test("provider failure leaves the previous export intact", () => {
  const bin = path.join(temp, "fake-provider");
  fs.mkdirSync(bin);
  const argsFile = path.join(temp, "fake-provider-args.json");
  fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}\nif(process.argv.includes('--version')) console.log('fake'); else { require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv)); console.error('fixture provider unavailable'); process.exitCode=3; }\n`, { mode: 0o755 });
  const output = path.join(temp, "preserve.json");
  fs.writeFileSync(output, "previous valid export");
  const result = spawnSync(process.execPath, [path.join(root, "bin/contextkit-network"), repo, "--provider", "claude", "--regenerate", "--timeout-seconds", "2", "--max-turns", "7", "--output", output], {
    cwd: temp, encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prior export preserved/);
  assert.equal(fs.readFileSync(output, "utf8"), "previous valid export");
  const args = JSON.parse(fs.readFileSync(argsFile, "utf8"));
  assert.equal(args[args.indexOf("--max-turns") + 1], "7");
});

test("retrying an invalid slice supplies validation feedback only for the same frozen request", () => {
  const dir = path.join(temp, "invalid-cache");
  fs.mkdirSync(dir);
  for (const name of ["STATIC_ANALYSIS.json", "SOURCE_INDEX.jsonl"]) fs.copyFileSync(path.join(workspace.dir, name), path.join(dir, name));
  const run = new RunWorkspace(dir);
  const doc = JSON.parse(fs.readFileSync(run.staticPath));
  const slice = SLICES.foundation;
  const result = semanticResults().foundation;
  result.components[0].paths = ["missing/entrypoint"];
  const envelope = { result, boundTo: {
    artifactId: doc.artifactId, treeFingerprint: doc.repository.treeFingerprint,
    contractVersion: slice.contractVersion, schemaHash: slice.schemaHash(), promptSetVersion: slice.promptSetVersion,
    foundationHash: null, sourceExposure: "static-only", requestedModel: null,
  } };
  const bin = path.join(temp, "retry-provider");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude"), `#!${process.execPath}\nif(process.argv.includes('--version')) console.log('fake'); else process.exitCode=3;\n`, { mode: 0o755 });
  const invoke = () => spawnSync(process.execPath, [path.join(root, "bin/contextkit-analyze"), dir, "--provider", "claude", "--reuse"], {
    cwd: temp, encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  run.writeSliceArtifact(1, "foundation", "claude", "response", envelope);
  assert.equal(invoke().status, 1);
  const request = () => JSON.parse(fs.readFileSync(run.slicePath(1, "foundation", "claude", "request")));
  assert.match(request().prompt, /Correct the previous candidate/);
  assert.match(request().prompt, /unknown-path/);
  assert.match(request().prompt, /missing\/entrypoint/);
  assert.match(request().systemPrompt, /absent from annotation fields/);
  envelope.boundTo.artifactId = "artifact.other";
  run.writeSliceArtifact(1, "foundation", "claude", "response", envelope);
  assert.equal(invoke().status, 1);
  assert.doesNotMatch(request().prompt, /Correct the previous candidate|missing\/entrypoint/);
});

test("cached-source evidence survives export and is checked against frozen bytes", () => {
  const dir = path.join(temp, "cached-source-run");
  fs.mkdirSync(dir);
  for (const name of ["STATIC_ANALYSIS.json", "SOURCE_INDEX.jsonl"]) fs.copyFileSync(path.join(workspace.dir, name), path.join(dir, name));
  const run = new RunWorkspace(dir);
  const store = RunStore.fromDirectory(dir, { includeSourceIndex: true });
  const journal = [];
  const server = new ContextKitMcpServer(store, { onEvidence: (r) => journal.push(r) });
  const chunk = [...store.chunksById.values()].find((c) => c.path === "src/api/main.ts");
  const resolved = server.callTool("resolve_evidence", { chunkId: chunk.chunkId, detail: "The entrypoint invokes storage" });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(journal.length, 1);
  const results = semanticResults();
  results.foundation.components[0].grounding = { basis: "observed", confidence: "high", evidenceIds: [journal[0].id], claimIds: [], notes: [] };
  for (const [id, result] of Object.entries(results)) {
    const slice = SLICES[id];
    const envelope = { result, mcpReport: { requestedEvidence: id === "foundation" ? journal : [] }, boundTo: {
      artifactId: store.document.artifactId, treeFingerprint: store.document.repository.treeFingerprint,
      schemaHash: slice.schemaHash(), contractVersion: slice.contractVersion, promptSetVersion: slice.promptSetVersion,
      sourceExposure: "cached-source", foundationHash: id === "foundation" ? null : resultHash(results.foundation),
    } };
    run.writeSliceArtifact(slice.order, id, "claude", "response", envelope);
    if (id === "foundation") {
      assert.equal(checkRequestedEvidence(envelope, store).errors.length, 0);
      const forged = structuredClone(envelope);
      forged.mcpReport.requestedEvidence[0].excerpt = "invented source";
      assert.equal(checkRequestedEvidence(forged, store).errors.length, 1);
      const wrongPolicy = structuredClone(envelope);
      wrongPolicy.boundTo.sourceExposure = "static-only";
      assert.equal(checkRequestedEvidence(wrongPolicy, store).errors.length, 1);
    }
  }
  const output = assembleNetwork(run, { provider: "claude" });
  assert.ok(output.evidence.some((e) => e.id === journal[0].id));
  assert.equal(JSON.parse(fs.readFileSync(run.staticPath)).evidence.some((e) => e.id === journal[0].id), false);
});
