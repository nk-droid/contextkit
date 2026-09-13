/**
 * Detector precision tests.
 *
 * Structural tests ask whether the artifact is well-formed. These ask whether it is
 * true, which is a different failure mode and the one that matters downstream: a
 * well-formed wrong fact is indistinguishable from a right one to everything after the
 * scanner, and protected-field enforcement will defend it faithfully.
 *
 * Every case here is drawn from a real false positive observed scanning ContextKit
 * itself - a route detected from the route detector's own doc comment, an entity from a
 * test fixture's inline source, an observability stack from a transitive dependency in
 * a lockfile.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { scanRepository } from "../src/analysis/scan-repository.mjs";
import {
  buildCodeMask, firstMatchInCode, isAuthored, matchesInCode, supportsMasking,
} from "../src/analysis/extractors/source-text.mjs";

let fixture;

function write(rel, content) {
  const full = path.join(fixture, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Scan the fixture as it currently stands. */
const scan = () => scanRepository(fixture).document;
const pathsOf = (document, collection) =>
  (document.detections[collection] ?? []).map(
    (r) => r.pathOrName ?? r.name ?? r.id);

before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ck-precision-"));
  write("package.json", JSON.stringify({ name: "precision-fixture", version: "1.0.0" }, null, 2));
});

after(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

describe("code masking", () => {
  const ROUTE = /\b(?:app|router)\.(get|post|put|patch|delete|all)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  const count = (text, file = "src/x.ts") =>
    [...matchesInCode(text, ROUTE, buildCodeMask(text, file))].length;

  test("finds a real registration", () => {
    assert.equal(count('app.get("/users", handler);'), 1);
  });

  test("ignores a block comment", () => {
    assert.equal(count('/** Express-style: app.get("/path", handler). */'), 0);
  });

  test("ignores a line comment", () => {
    assert.equal(count('// app.get("/retired", handler);'), 0);
  });

  test("ignores a registration quoted inside a string", () => {
    assert.equal(count(`write("src/s.ts", 'app.post("/github", h)');`), 0);
  });

  test("ignores a template literal", () => {
    assert.equal(count("const sample = `app.put(\"/t\", h)`;"), 0);
  });

  test("still finds code after a comment, a regex, and an apostrophe", () => {
    assert.equal(count('// app.get("/old")\napp.get("/new", h);'), 1);
    assert.equal(count('const re = /a\\/b/;\napp.get("/after", h);'), 1);
    assert.equal(count("// don't break\napp.get('/ok', h);"), 1);
  });

  test("does not mistake division for a regex", () => {
    assert.equal(count('const r = a / b;\napp.get("/ok", h);'), 1);
  });

  test("leaves data files unmasked, where content is the point", () => {
    for (const file of ["a.json", "a.md", "a.sql", "a.lock"]) {
      assert.equal(supportsMasking(file), false, file);
      assert.equal(buildCodeMask("anything", file), null, file);
    }
    for (const file of ["a.ts", "a.py", "Makefile"]) {
      assert.ok(buildCodeMask("anything", file), file);
    }
  });

  test("treats a module specifier as code, not as a string", () => {
    // The counterweight to masking: an import specifier is the strongest adoption signal
    // a file has, so masking it would trade false positives for false negatives.
    const SIGNAL = /@opentelemetry/g;
    const found = (text) => Boolean(firstMatchInCode(text, SIGNAL, buildCodeMask(text, "a.ts")));
    assert.equal(found('import { trace } from "@opentelemetry/api";'), true);
    assert.equal(found("import '@opentelemetry/api';"), true);
    assert.equal(found('const x = require("@opentelemetry/api");'), true);
    assert.equal(found('export { trace } from "@opentelemetry/api";'), true);
    assert.equal(found('await import("@opentelemetry/api");'), true);

    // but a commented-out or quoted import stays masked
    assert.equal(found('// import { trace } from "@opentelemetry/api";'), false);
    assert.equal(found('/* import "@opentelemetry/api"; */'), false);
    assert.equal(found(`const sample = 'import "@opentelemetry/api"';`), false);
  });

  test("masks python docstrings and hash comments", () => {
    const DECORATOR = /@(?:\w+\.)?(get|post)\s*\(/g;
    const inCode = (text) => Boolean(firstMatchInCode(text, DECORATOR, buildCodeMask(text, "a.py")));
    assert.equal(inCode('@router.post("/x")\ndef f(): pass'), true);
    assert.equal(inCode('def f():\n    """@router.post("/doc")"""\n    pass'), false);
    assert.equal(inCode('# @router.post("/c")\ndef f(): pass'), false);
  });
});

describe("authored-file rule", () => {
  test("generated and vendored files are excluded from signal matching", () => {
    assert.equal(isAuthored({ generated: false, vendored: false }), true);
    assert.equal(isAuthored({ generated: true, vendored: false }), false);
    assert.equal(isAuthored({ generated: false, vendored: true }), false);
    assert.equal(isAuthored(null), false);
  });
});

describe("routes are not detected from documentation", () => {
  test("a registration in a doc comment is not a route", () => {
    write("src/server.ts", [
      "/**",
      ' * Express-style registration: app.get("/documented", handler).',
      " */",
      "export function noop() { return 1; }",
      "",
    ].join("\n"));
    try {
      assert.deepEqual(pathsOf(scan(), "routes"), []);
    } finally {
      fs.rmSync(path.join(fixture, "src/server.ts"));
    }
  });

  test("a registration inside a string literal is not a route", () => {
    write("src/fixture-builder.ts", [
      "export function buildFixture(write) {",
      `  write("app.ts", 'app.post("/from-a-fixture", handler)');`,
      "}",
      "",
    ].join("\n"));
    try {
      assert.deepEqual(pathsOf(scan(), "routes"), []);
    } finally {
      fs.rmSync(path.join(fixture, "src/fixture-builder.ts"));
    }
  });

  test("a real registration beside both is still detected", () => {
    write("src/server.ts", [
      '// app.get("/commented-out", handler);',
      "export function mount(app) {",
      `  const sample = 'app.delete("/in-a-string", h)';`,
      '  app.get("/real", handler);',
      "  return sample;",
      "}",
      "",
    ].join("\n"));
    try {
      assert.deepEqual(pathsOf(scan(), "routes"), ["/real"]);
    } finally {
      fs.rmSync(path.join(fixture, "src/server.ts"));
    }
  });
});

describe("signals are not detected from generated files", () => {
  test("a transitive dependency in a lockfile is not an adopted technology", () => {
    // The real case: ContextKit reported "uses OpenTelemetry" because something four
    // levels down the dependency tree depends on @opentelemetry/api.
    write("package-lock.json", JSON.stringify({
      name: "precision-fixture", lockfileVersion: 3,
      packages: { "node_modules/@opentelemetry/api": { version: "1.9.0" } },
    }, null, 2));
    try {
      assert.deepEqual(pathsOf(scan(), "observability"), []);
    } finally {
      fs.rmSync(path.join(fixture, "package-lock.json"));
    }
  });

  test("the same signal in authored code is detected", () => {
    write("src/telemetry.ts", [
      'import { trace } from "@opentelemetry/api";',
      "export const tracer = trace.getTracer('app');",
      "",
    ].join("\n"));
    try {
      assert.ok(pathsOf(scan(), "observability").includes("OpenTelemetry"),
        "an authored import is a real adoption signal");
    } finally {
      fs.rmSync(path.join(fixture, "src/telemetry.ts"));
    }
  });
});

describe("entities are not detected from inline sample source", () => {
  test("a table declaration inside a test fixture string is not an entity", () => {
    write("tests/builder.test.ts", [
      "export function setup(write) {",
      `  write("schema.ts", 'export const runs = sqliteTable("runs", {});');`,
      "}",
      "",
    ].join("\n"));
    try {
      assert.deepEqual(pathsOf(scan(), "dataEntities"), []);
    } finally {
      fs.rmSync(path.join(fixture, "tests/builder.test.ts"));
    }
  });

  test("a real table declaration is detected", () => {
    write("src/schema.ts", [
      'import { sqliteTable, text } from "drizzle-orm/sqlite-core";',
      'export const accounts = sqliteTable("accounts", { id: text("id") });',
      "",
    ].join("\n"));
    try {
      assert.deepEqual(pathsOf(scan(), "dataEntities"), ["accounts"]);
    } finally {
      fs.rmSync(path.join(fixture, "src/schema.ts"));
    }
  });
});

describe("the detector does not detect itself", () => {
  test("a signal table listing technology names emits nothing", () => {
    // This is what made the bug obvious: platform.mjs listed "OpenTelemetry" as a signal
    // and the scanner reported ContextKit as using it.
    write("src/signals.ts", [
      "export const SIGNALS = [",
      '  { name: "OpenTelemetry", pattern: /@opentelemetry/ },',
      '  { name: "Sentry", pattern: /@sentry/ },',
      "];",
      "",
    ].join("\n"));
    try {
      const document = scan();
      assert.deepEqual(pathsOf(document, "observability"), [],
        "names inside a signal table are data, not adoption");
    } finally {
      fs.rmSync(path.join(fixture, "src/signals.ts"));
    }
  });
});
