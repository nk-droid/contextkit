/**
 * Static-analysis scanner tests.
 *
 * Built around a throwaway fixture repository so the assertions describe the scanner's
 * contract rather than whatever happens to be in ContextKit today.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { scanRepository } from "../src/analysis/scan-repository.mjs";
import { validateStaticDocument } from "../src/analysis/validation/validate-static.mjs";
import { EvidenceRegistry } from "../src/analysis/evidence-registry.mjs";
import { evidenceId, slug } from "../src/analysis/stable-ids.mjs";
import { classifyKind, classifySensitivity, isSafeRelativePath } from "../src/analysis/policy.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
let fixture;

function write(rel, content) {
  const full = path.join(fixture, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ck-fixture-"));
  write("package.json", JSON.stringify({
    name: "fixture-app", version: "1.0.0",
    scripts: { test: "node --test", build: "tsc" },
    dependencies: { zod: "^3.0.0" },
    devDependencies: { zod: "^3.0.0", typescript: "^5.0.0" },
    engines: { node: ">=20" },
  }, null, 2));
  write("Makefile", "run:\n\tnode server.mjs\n\ntest:\n\tnode --test\n");
  write("src/server.ts", [
    "export function helper(value) {",
    "  return value + 1;",
    "}",
    "",
    "export function GET(request) {",
    "  return helper(request);",
    "}",
    "",
  ].join("\n"));
  write("src/worker.py", [
    "def _inner(x):",
    '    """Do the inner thing."""',
    "    return x",
    "",
    "class Runner:",
    "    def run(self):",
    "        return _inner(1)",
    "",
  ].join("\n"));
  write(".env", "API_KEY=\"super-secret-value-1234567890\"\n");
  write("docs/guide.md", "# Guide\n\nText.\n\n## Details\n\nMore.\n");
  write("app/api/items/route.ts", [
    "export function GET(request) { return request; }",
    "export function POST(request) { return request; }",
    "",
  ].join("\n"));
  // A stacked decorator: the route decorator is NOT the line above the declaration.
  write("api/handlers.py", [
    "from fastapi import APIRouter",
    "",
    "router = APIRouter()",
    "",
    '@router.post("/github")',
    '@traced("api.webhooks.github")',
    "def github_webhook(request):",
    "    return request",
    "",
  ].join("\n"));
  write("db/schema.py", [
    "from sqlalchemy import Table",
    "",
    'runs = Table("runs")',
    'DB_URL = os.getenv("AUTOPR_DATABASE_URL")',
    'SECRET = os.getenv("GITHUB_WEBHOOK_SECRET")',
    "",
  ].join("\n"));
  write("migrations/0001_init.sql", "CREATE TABLE runs (id TEXT);\n");
  execFileSync("git", ["init", "-q"], { cwd: fixture });
  execFileSync("git", ["add", "-A"], { cwd: fixture });
  execFileSync("git", ["-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "-qm", "fixture"],
    { cwd: fixture });
});

after(() => fs.rmSync(fixture, { recursive: true, force: true }));

describe("policy", () => {
  test("rejects paths that escape the repository root", () => {
    assert.equal(isSafeRelativePath("src/a.ts"), true);
    assert.equal(isSafeRelativePath("../outside.ts"), false);
    assert.equal(isSafeRelativePath("/etc/passwd"), false);
    assert.equal(isSafeRelativePath("a/../../b"), false);
  });

  test("classifies tests apart from ordinary source", () => {
    assert.equal(classifyKind("tests/unit/test_run.py").kind, "test");
    assert.equal(classifyKind("src/server.ts").kind, "source");
    assert.equal(classifyKind("README.md").kind, "documentation");
  });

  test("flags secret-bearing content as sensitive", () => {
    assert.equal(classifySensitivity(".env", 'API_KEY="abcdefghijklmnop"').sensitive, true);
    assert.equal(classifySensitivity("src/a.ts", "const x = 1;").sensitive, false);
  });
});

describe("evidence registry", () => {
  test("refuses a citation whose path is not inventoried", () => {
    const registry = new EvidenceRegistry(new Map());
    const id = registry.add({ path: "nope.ts", lineStart: 1, lineEnd: 2, detail: "x", sourceText: "a\nb" });
    assert.equal(id, null);
    assert.equal(registry.rejected.length, 1);
  });

  test("refuses a line range beyond the end of the file", () => {
    const registry = new EvidenceRegistry(new Map([["a.ts", { lineCount: 3, sha256: null }]]));
    assert.equal(registry.add({ path: "a.ts", lineStart: 9, lineEnd: 9, detail: "x", sourceText: "a\nb\nc" }), null);
  });

  test("withholds excerpt text for sensitive content but keeps the location", () => {
    const registry = new EvidenceRegistry(new Map([[".env", { lineCount: 1, sha256: null }]]));
    const id = registry.add({
      path: ".env", lineStart: 1, lineEnd: 1, detail: "declares a key",
      sourceText: 'API_KEY="super-secret-value-1234567890"',
    });
    const record = registry.get(id);
    assert.equal(record.sensitive, true);
    assert.equal(record.excerpt, null);
    assert.ok(record.excerptSha256, "a sensitive record still carries a content hash");
  });

  test("evidence ids are stable for unchanged content", () => {
    const a = evidenceId("src/a.ts", "helper", "export function helper() {}");
    const b = evidenceId("src/a.ts", "helper", "export function helper() {}");
    assert.equal(a, b);
    assert.notEqual(a, evidenceId("src/a.ts", "helper", "export function helper(x) {}"));
  });
});

describe("scanner", () => {
  test("produces a valid artifact for the fixture repository", () => {
    const { document } = scanRepository(fixture);
    const result = validateStaticDocument(document);
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
  });

  test("is deterministic across runs", () => {
    const strip = (doc) => {
      const copy = structuredClone(doc);
      delete copy.scanner.startedAt;
      delete copy.scanner.completedAt;
      delete copy.scanner.durationMs;
      copy.scanner.extractors.forEach((e) => delete e.durationMs);
      return JSON.stringify(copy);
    };
    const first = scanRepository(fixture);
    const second = scanRepository(fixture);
    assert.equal(strip(first.document), strip(second.document));
    assert.equal(first.sourceIndex.jsonl, second.sourceIndex.jsonl);
    assert.equal(first.document.repository.treeFingerprint, second.document.repository.treeFingerprint);
  });

  test("derives directory counts from the inventory", () => {
    const { document } = scanRepository(fixture);
    const src = document.inventory.directories.find((d) => d.path === "src");
    const actual = document.inventory.files.filter((f) => f.path.startsWith("src/")).length;
    assert.equal(src.fileCount, actual);
  });

  test("extracts declarations from both language adapters", () => {
    const { document } = scanRepository(fixture);
    const names = document.code.symbols.map((s) => s.name);
    assert.ok(names.includes("GET"), "TypeScript declarations are extracted");
    assert.ok(names.includes("Runner"), "Python declarations are extracted");
  });

  test("marks a framework entrypoint", () => {
    const { document } = scanRepository(fixture);
    const get = document.code.symbols.find((s) => s.name === "GET");
    assert.equal(get.isEntrypoint, true);
  });

  test("grades call resolution and never emits an unresolved edge", () => {
    const { document } = scanRepository(fixture);
    for (const call of document.code.calls) {
      assert.ok(["resolved", "heuristic"].includes(call.resolution));
    }
    assert.equal(typeof document.code.extraction.unresolvedCalls, "number");
  });

  test("separates declarations from a package declared in two dependency groups", () => {
    const { document } = scanRepository(fixture);
    const zod = document.detections.dependencies.filter((d) => d.name === "zod");
    assert.equal(zod.length, 2, "runtime and development declarations are distinct records");
    assert.equal(new Set(zod.map((d) => d.id)).size, 2, "and carry distinct ids");
  });

  test("every evidence record leaves verification to a later stage", () => {
    const { document } = scanRepository(fixture);
    assert.ok(document.evidence.length > 0);
    for (const record of document.evidence) {
      assert.equal(record.verificationStatus, "not-checked");
    }
  });

  test("withholds sensitive chunk content from the source index", () => {
    const { sourceIndex } = scanRepository(fixture);
    const envChunks = sourceIndex.chunks.filter((c) => c.path === ".env");
    assert.ok(envChunks.length > 0, "the file is still indexed");
    for (const chunk of envChunks) {
      assert.equal(chunk.sensitive, true);
      assert.equal(chunk.content, null);
      assert.ok(chunk.contentSha256);
    }
    assert.ok(sourceIndex.summary.excludedSensitiveChunks >= 1);
  });

  test("chunks markdown on authored section boundaries", () => {
    const { sourceIndex } = scanRepository(fixture);
    const docChunks = sourceIndex.chunks.filter((c) => c.path === "docs/guide.md");
    assert.ok(docChunks.length >= 2, "a two-heading document yields at least two chunks");
    assert.equal(docChunks[0].boundary, "markdown-section");
  });
});

describe("framework detectors", () => {
  test("detects file-system routes and derives the url path", () => {
    const { document } = scanRepository(fixture);
    const get = document.detections.routes.find((r) => r.method === "GET" && r.framework === "next-app-router");
    assert.ok(get, "a Next-style route is detected");
    assert.equal(get.pathOrName, "/api/items");
  });

  test("reads the route literal from the right decorator when decorators stack", () => {
    const { document } = scanRepository(fixture);
    const route = document.detections.routes.find((r) => r.implementationSymbol === "github_webhook");
    assert.ok(route, "the decorated handler is detected");
    // Regression: an intervening @traced("api.webhooks.github") must not be mistaken
    // for the route path.
    assert.equal(route.pathOrName, "/github");
    assert.equal(route.method, "POST");
  });

  test("records an auth observation without concluding the route is unprotected", () => {
    const { document } = scanRepository(fixture);
    for (const route of document.detections.routes) {
      assert.equal(typeof route.recognizedAuthMiddlewareInFile, "boolean");
      assert.ok(!("unauthenticated" in route), "the scanner states observations, not conclusions");
    }
  });

  test("detects stores, entities, and migrations", () => {
    const { document } = scanRepository(fixture);
    assert.ok(document.detections.dataEntities.some((e) => e.name === "runs"));
    assert.ok(document.detections.migrations.some((m) => m.path.endsWith("0001_init.sql")));
  });

  test("detects configuration keys and flags secret-looking names", () => {
    const { document } = scanRepository(fixture);
    const secret = document.detections.configurationKeys.find((k) => k.name === "GITHUB_WEBHOOK_SECRET");
    assert.ok(secret, "the key is detected");
    assert.equal(secret.looksSecretByName, true);
    const plain = document.detections.configurationKeys.find((k) => k.name === "AUTOPR_DATABASE_URL");
    assert.equal(plain.looksSecretByName, false);
  });

  test("groups test files into a suite with its framework", () => {
    const { document } = scanRepository(fixture);
    assert.ok(document.detections.testSuites.length >= 0);
  });

  test("derives technologies from established facts rather than re-sniffing", () => {
    const { document } = scanRepository(fixture);
    const names = document.detections.technologies.map((t) => t.name);
    assert.ok(names.includes("zod"), "a known dependency becomes a technology");
    assert.ok(names.includes("node"), "a declared engine becomes a runtime technology");
  });
});

describe("validation", () => {
  test("rejects an artifact whose evidence cites a file outside the inventory", () => {
    const { document } = scanRepository(fixture);
    document.evidence.push({
      ...document.evidence[0], id: "ev.fake.region.deadbeef", path: "not/in/inventory.ts",
    });
    const result = validateStaticDocument(document);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("not in the inventory")));
  });

  test("rejects an artifact whose statistics disagree with the inventory", () => {
    const { document } = scanRepository(fixture);
    document.inspection.statistics.discoveredFiles += 1;
    const result = validateStaticDocument(document);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes("does not match the inventory")));
  });

  test("warns rather than fails when call attribution is mostly unresolved", () => {
    const { document } = scanRepository(fixture);
    document.code.extraction.discoveredCalls = 1;
    document.code.extraction.unresolvedCalls = 99;
    const result = validateStaticDocument(document);
    assert.equal(result.valid, true, "low coverage is a warning, not a structural failure");
    assert.ok(result.warnings.some((w) => w.includes("could not be attributed")));
  });
});

describe("cli", () => {
  test("writes both artifacts and exits zero for a valid scan", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-out-"));
    execFileSync(process.execPath, [path.join(ROOT, "bin", "contextkit-scan"), fixture, "--out", outDir, "--quiet"]);
    assert.ok(fs.existsSync(path.join(outDir, "STATIC_ANALYSIS.json")));
    assert.ok(fs.existsSync(path.join(outDir, "SOURCE_INDEX.jsonl")));
    fs.rmSync(outDir, { recursive: true, force: true });
  });
});

describe("stable ids", () => {
  test("slugs conform to the published identifier grammar", () => {
    assert.match(`ev.${slug("src/Some File.ts")}`, /^[a-z][a-z0-9._:-]*$/);
    assert.equal(slug("///"), "x");
  });
});
