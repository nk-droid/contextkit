// The agent provider: an interactive agent prepares, analyzes, and submits slices itself,
// and contextkit network exports them. Every test works on one run, in order.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { SLICES } from "../src/analysis/slices/plan-slices.mjs";
import { parseNetworkFacts } from "../src/network/schema.mjs";

const root = path.resolve(import.meta.dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-agent-provider-"));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const node = (bin, ...args) => spawnSync(process.execPath, [path.join(root, "bin", bin), ...args],
  { cwd: temp, encoding: "utf8" });
const writeJson = (name, value) => {
  const file = path.join(temp, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};

function repository(files) {
  const dir = path.join(temp, "repo");
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Fixture");
  return dir;
}

const repo = repository({
  "src/api/main.ts": 'import { read } from "../storage/db"; export function main() { return read(); }\n',
  "src/storage/db.ts": "export function read() {\n  return 42;\n}\n",
});
const staticExport = path.join(temp, "out", "NETWORK_FACTS.json");
const scan = node("contextkit-network", repo, "--output", staticExport);
const run = /^Run: (.+)$/m.exec(scan.stdout)?.[1];
const analysis = (file) => path.join(run, "analysis", file);
const agent = (slice, ...args) => node("contextkit-analyze", run, "--slice", slice, "--provider", "agent", ...args);
const tool = (slice, name, params) => node("contextkit-mcp", run, "call", name,
  typeof params === "string" ? params : JSON.stringify(params), "--provider", "agent", "--slice", slice);

// The smallest results the slices accept: the static network's directory components with
// inferred grounding, and nothing else claimed.
function minimalResults() {
  const facts = JSON.parse(fs.readFileSync(staticExport, "utf8"));
  const grounding = { basis: "inferred", confidence: "medium", evidenceIds: [], claimIds: [], notes: [] };
  return {
    foundation: {
      primaryUsers: [], capabilities: [], nonGoals: [], repositoryRoles: [], styles: [],
      externalSystems: [], annotations: [],
      components: facts.architecture.components.map((c) => ({
        ...c, nonResponsibilities: [], entrypointIds: [], technologyIds: [], stateStoreIds: [],
        ownerHint: null, grounding,
      })),
    },
    "behavior-data": {
      relationships: [], runtimeFlows: [], boundaries: [], invariants: [], apiSurfaces: [],
      dataContracts: [], stores: [], entities: [], retentionRules: [], consistencyRules: [], annotations: [],
    },
  };
}
const storageComponent = (foundation) => foundation.components.find((c) => c.paths.some(
  (p) => p === "." || "src/storage/db.ts".startsWith(`${p}/`))) ?? foundation.components[0];
const observed = (evidenceIds) => ({ basis: "observed", confidence: "high", evidenceIds, claimIds: [], notes: [] });

let evidenceId;

test("prepare hands the agent its prompt and schema without contacting a provider", () => {
  assert.equal(scan.status, 0, scan.stderr);
  const prepared = agent("foundation", "--prepare");
  assert.equal(prepared.status, 0, prepared.stderr);
  const prompt = fs.readFileSync(analysis("01-foundation.agent.prompt.md"), "utf8");
  assert.doesNotMatch(prompt, /\{\{\w+\}\}/);
  assert.ok(prompt.includes(path.basename(run)), "prompt names this run");
  assert.ok(prompt.includes("--provider agent --slice foundation"));
  assert.ok(prompt.includes("## Briefing"));
  assert.deepEqual(JSON.parse(fs.readFileSync(analysis("01-foundation.agent.schema.json"), "utf8")),
    SLICES.foundation.loadSchema());
  assert.equal(fs.existsSync(analysis("01-foundation.agent.response.json")), false);
});

test("calls and resolved evidence are logged for the slice, and later calls see that evidence", () => {
  const found = tool("foundation", "find_chunks", { path: "src/storage/db.ts" });
  assert.equal(found.status, 0, found.stderr);
  const [chunk] = JSON.parse(found.stdout).chunks;
  const resolved = tool("foundation", "resolve_evidence", { chunkId: chunk.chunkId, detail: "declares read" });
  assert.equal(resolved.status, 0, resolved.stderr);
  evidenceId = JSON.parse(resolved.stdout).id;

  // A separate process, so the evidence can only come from the log.
  const results = minimalResults();
  storageComponent(results.foundation).grounding = observed([evidenceId]);
  const params = writeJson("validate.json", { sliceId: "foundation", candidate: results.foundation });
  const checked = tool("foundation", "validate_slice", `@${params}`);
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(JSON.parse(checked.stdout).errors, []);

  const log = analysis("01-foundation.agent.mcp-access.json");
  const calls = fs.readFileSync(`${log}l`, "utf8").trim().split("\n").map((line) => JSON.parse(line).name);
  assert.deepEqual(calls, ["find_chunks", "resolve_evidence", "validate_slice"]);
  const records = fs.readFileSync(`${log}.evidence.jsonl`, "utf8").trim().split("\n");
  assert.deepEqual(records.map((line) => JSON.parse(line).id), [evidenceId]);
});

test("a rejected submission is stored with its violations, and unreadable results are refused", () => {
  const unreadable = path.join(temp, "unreadable.json");
  fs.writeFileSync(unreadable, "{ components: ");
  const refused = agent("foundation", "--result", unreadable);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /not valid JSON/);

  const results = minimalResults();
  storageComponent(results.foundation).grounding = observed(["ev.src-storage-db.ts.invented.deadbeef"]);
  const rejected = agent("foundation", "--result", writeJson("invented.json", results.foundation));
  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout, /INVALID/);
  assert.match(rejected.stdout, /unresolved-evidence/);
  const stored = JSON.parse(fs.readFileSync(analysis("01-foundation.agent.response.json"), "utf8"));
  assert.equal(stored.provider, "agent");
  assert.equal(stored.boundTo.sourceExposure, "cached-source");
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, "validation-foundation.agent.json"), "utf8")).valid, false);
  // Nothing may build on a foundation that never validated.
  assert.equal(agent("behavior-data", "--prepare").status, 2);
});

test("valid submissions freeze foundation, unlock behavior-data, and export", () => {
  const results = minimalResults();
  // Evidence resolved in an earlier command must survive to the final gate.
  storageComponent(results.foundation).grounding = observed([evidenceId]);
  const foundation = agent("foundation", "--result", writeJson("foundation.json", results.foundation));
  assert.equal(foundation.status, 0, foundation.stdout + foundation.stderr);
  assert.match(foundation.stdout, /VALID/);
  assert.ok(fs.existsSync(path.join(run, "ENTITY_REGISTRY.json")));

  assert.equal(agent("behavior-data", "--prepare").status, 0);
  const behavior = agent("behavior-data", "--result", writeJson("behavior.json", results["behavior-data"]));
  assert.equal(behavior.status, 0, behavior.stdout + behavior.stderr);

  const output = path.join(temp, "out", "semantic.json");
  const exported = node("contextkit-network", run, "--provider", "agent", "--output", output);
  assert.equal(exported.status, 0, exported.stderr);
  assert.match(exported.stdout, /Reusing validated foundation/);
  assert.match(exported.stdout, /Reusing validated behavior-data/);
  const facts = JSON.parse(fs.readFileSync(output, "utf8"));
  assert.equal(facts.coverage.mode, "semantic");
  parseNetworkFacts(facts);

  const reexported = node("contextkit-export-network", run, "--provider", "agent", "--output", path.join(temp, "out", "again.json"));
  assert.equal(reexported.status, 0, reexported.stderr);
});

test("agent mode refuses options that do not apply to it", () => {
  for (const args of [["--model", "some-model"], ["--prepare", "--result", "result.json"]]) {
    assert.notEqual(agent("foundation", ...args).status, 0, args.join(" "));
  }
  assert.notEqual(node("contextkit-analyze", run, "--slice", "foundation", "--provider", "claude", "--prepare").status, 0);
  const regenerate = node("contextkit-network", run, "--provider", "agent", "--regenerate", "--output", path.join(temp, "x.json"));
  assert.match(regenerate.stderr, /--regenerate does not apply/);
});
