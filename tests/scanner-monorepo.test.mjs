import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { scanRepository } from "../src/analysis/scan-repository.mjs";
import { validateStaticDocument } from "../src/analysis/validation/validate-static.mjs";
import { compareRuns } from "../src/analysis/validation/determinism.mjs";
import { checkRunBinding } from "../src/analysis/slices/foundation.mjs";
import { detectionId, evidenceId, symbolId } from "../src/analysis/stable-ids.mjs";

let root, document;
const longPath = "libs/very-long-package-name/nested/another-very-long-directory/models";
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ck-monorepo-"));
  const files = {
    "libs/core/pyproject.toml": `[project]
name = "fixture"
dependencies = ["numpy>=1; python_version<'3.13'", "numpy>=2; python_version>='3.13'"]
[project.optional-dependencies]
test = [
  "httpx[http2]>=0.27; python_version >= '3.10'", # "not-a-dependency"
  'numpy>=1; python_version < "3.13"',
  "numpy>=2; python_version>='3.13'",
  "numpy>=2; python_version>='3.13'",
]
[dependency-groups]
test = [{ include-group = "lint" }, "pytest>=8"]
[tool.ruff.lint]
select = ["NOT_A_DEPENDENCY"]
`,
    "libs/core/requirements.txt": "numpy>=1; python_version<'3.13'\nnumpy>=2; python_version>='3.13'\n",
    "libs/core/Makefile": `lint_tests: PYTHON_FILES=tests
lint_tests: MYPY_CACHE=.cache
lint_package lint_tests: UV_RUN_LINT=uv run
lint lint_package lint_tests:
\tpython -m ruff check .
build: first
build: second
\tpython -m build
conditional:
\techo one
conditional:
\techo two
`,
    "models.py": `from pydantic import BaseModel
"""
class ExampleOnly(BaseModel): pass
"""
# class CommentOnly(BaseModel): pass
def first():
    class Shared(BaseModel): pass
def second():
    class Shared(BaseModel): pass
`,
    "models.ts": 'const docs = "const Fake = z.object({})";\nfunction first() { const Shared = z.object({}); }\nfunction second() { const Shared = z.object({}); }\n',
    "README.md": "class DocumentationOnly(BaseModel): pass\nconst DocumentationSchema = z.object({});\n",
    [`${longPath}/first.py`]: "from pydantic import BaseModel\nclass Model(BaseModel): pass\n",
    [`${longPath}/second.py`]: "from pydantic import BaseModel\nclass Model(BaseModel): pass\n",
    "names.ts": "export function Foo() { return 1; }\nexport function foo() { return Foo(); }\n",
  };
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  document = scanRepository(root).document;
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("monorepo declarations produce valid, deterministic static facts", () => {
  assert.deepEqual(validateStaticDocument(document).errors, []);
  assert.equal(compareRuns(document, scanRepository(root).document).deterministic, true);
});

test("conditional Python requirements retain their complete markers and extras", () => {
  const deps = document.detections.dependencies;
  assert.equal(deps.length, 8, JSON.stringify(deps));
  const runtime = deps.filter(d => d.sourcePath.endsWith("pyproject.toml") && d.kind === "runtime");
  assert.deepEqual(runtime.map(d => d.versionConstraint).sort(), [">=1; python_version<'3.13'", ">=2; python_version>='3.13'"]);
  const extras = deps.find(d => d.name === "httpx");
  assert.equal(extras.versionConstraint, "[http2]>=0.27; python_version >= '3.10'");
  const numpy = deps.filter(d => d.sourcePath.endsWith("pyproject.toml") && d.dependencyGroup === "test" && d.name === "numpy");
  assert.equal(numpy.length, 2);
  assert.ok(numpy.some(d => d.versionConstraint === '>=1; python_version < "3.13"'));
  for (const dep of deps) {
    const evidence = document.evidence.find(e => dep.evidenceIds.includes(e.id));
    assert.ok(evidence.excerpt.includes(dep.name));
  }
});

test("Make target settings and multi-target recipes form one command per target", () => {
  const commands = document.detections.commands;
  assert.deepEqual(commands.map(c => c.name).sort(), ["build", "conditional", "lint", "lint_package", "lint_tests"]);
  const lint = commands.find(c => c.name === "lint_tests");
  assert.equal(lint.workingDirectory, "libs/core");
  assert.equal(lint.rawCommand, "python -m ruff check .");
  assert.equal(lint.evidenceIds.length, 4);
  assert.equal(commands.find(c => c.name === "build").rawCommand, "python -m build");
  assert.equal(commands.find(c => c.name === "conditional").rawCommand, null);
});

test("repeated model names remain distinct while docstrings and examples stay excluded", () => {
  const contracts = document.detections.dataContracts;
  assert.equal(contracts.length, 6, JSON.stringify(contracts));
  const shared = contracts.filter(c => c.definitionPath === "models.py");
  assert.equal(shared.length, 2);
  assert.notEqual(shared[0].id, shared[1].id);
  for (const contract of contracts) {
    const evidence = document.evidence.find(e => contract.evidenceIds.includes(e.id));
    assert.equal(evidence.path, contract.definitionPath);
    assert.equal(evidence.lineStart, contract.lineStart);
  }
});

test("stable IDs distinguish full paths, names, case and argument boundaries within the size limit", () => {
  const paths = [`${longPath}/first.py`, `${longPath}/second.py`, "a/b.py", "a-b.py"];
  for (const makeId of [p => symbolId(p, "Model"), p => detectionId("contract", p, "Model"), p => evidenceId(p, "Model", "identical text")]) {
    assert.equal(new Set(paths.map(makeId)).size, paths.length);
  }
  const symbols = document.code.symbols.filter(s => s.path === "names.ts");
  assert.equal(symbols.length, 2);
  assert.notEqual(symbols[0].id, symbols[1].id);
  assert.ok(document.code.calls.some(c => c.callerSymbolId === symbols.find(s => s.name === "foo").id && c.calleeSymbolId === symbols.find(s => s.name === "Foo").id));
  assert.notEqual(detectionId("dep", "a.b", "c"), detectionId("dep", "a", "b.c"));
  assert.notEqual(detectionId("cmd", "Makefile", "A"), detectionId("cmd", "Makefile", "a"));
  for (const id of [detectionId("dep", ...Array(8).fill("long".repeat(80))), `ep.${symbolId("long".repeat(80), "name".repeat(80))}`]) {
    assert.ok(id.length <= 160);
    assert.match(id, /^[a-z][a-z0-9._:-]*$/);
  }
});

test("changed scan configuration invalidates semantic bindings without changing source identity", () => {
  const changed = scanRepository(root, { limits: { maxRetainedSymbols: 2 } }).document;
  assert.equal(changed.repository.treeFingerprint, document.repository.treeFingerprint);
  assert.notEqual(changed.artifactId, document.artifactId);
  const validation = checkRunBinding({ boundTo: { artifactId: document.artifactId, treeFingerprint: document.repository.treeFingerprint } }, {
    artifactId: changed.artifactId, treeFingerprint: changed.repository.treeFingerprint,
  });
  assert.ok(validation.errors.some(e => e.code === "artifact-mismatch"));
});

test("a failed quiet scan prints bounded errors and retains complete diagnostic artifacts", () => {
  // Inject an invalid scanner result at the module boundary so this tests the real
  // CLI, validator and workspace failure path without depending on an unfixed bug.
  const bad = structuredClone(document);
  bad.code.symbols.push(...Array(12).fill(bad.code.symbols[0]));
  const expected = validateStaticDocument(bad);
  assert.equal(expected.errors.length, 12);
  const loader = path.join(root, "invalid-scan-loader.mjs");
  const preload = path.join(root, "invalid-scan-preload.mjs");
  const scannerUrl = new URL("../src/analysis/scan-repository.mjs", import.meta.url).href;
  const moduleSource = `export function scanRepository() { return ${JSON.stringify({ document: bad, sourceIndex: { jsonl: "" } })}; }`;
  fs.writeFileSync(loader, `export async function load(url, context, next) {
    if (url === ${JSON.stringify(scannerUrl)}) return { format: 'module', shortCircuit: true, source: ${JSON.stringify(moduleSource)} };
    return next(url, context);
  }`);
  fs.writeFileSync(preload, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)});`);
  const script = `import { ensureRunWorkspace } from ${JSON.stringify(new URL("../src/analysis/run-workspace.mjs", import.meta.url).href)};
    try { ensureRunWorkspace(${JSON.stringify(root)}); }
    catch (error) { console.error(error.message); process.exitCode = 1; }`;
  let retained;
  try {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
    });
    retained = /diagnostic artifacts retained in (.+)/.exec(child.stderr)?.[1];
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /duplicate id/);
    assert.match(child.stderr, /2 more errors/);
    assert.equal(child.stderr.split("duplicate id").length - 1, 10);
    assert.ok(retained, child.stderr);
    const report = JSON.parse(fs.readFileSync(path.join(retained, "STATIC_VALIDATION.json")));
    assert.deepEqual(report, expected);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(retained, "STATIC_ANALYSIS.json"))), bad);
  } finally {
    if (retained) fs.rmSync(retained, { recursive: true, force: true });
    fs.rmSync(loader, { force: true });
    fs.rmSync(preload, { force: true });
  }
});
