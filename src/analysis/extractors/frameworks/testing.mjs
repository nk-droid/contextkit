/**
 * Test, configuration, and observability detectors.
 *
 * All three record declarations. Whether tests pass, whether a config key is set in
 * production, and whether telemetry actually reaches a backend are outside what source
 * inspection can establish, and are left to the semantic and verification stages.
 */
import path from "node:path";
import { detectionId } from "../../stable-ids.mjs";
import { ExtractorRun } from "../extractor.mjs";

const VERSION = "1.0.0";

const TEST_FRAMEWORKS = [
  { name: "pytest", pattern: /\bimport pytest\b|@pytest\.|\bpytest\.mark\b/ },
  { name: "node:test", pattern: /from ["']node:test["']|require\(["']node:test["']\)/ },
  { name: "jest", pattern: /\b(jest|describe|it)\s*\(/ },
  { name: "vitest", pattern: /from ["']vitest["']/ },
  { name: "unittest", pattern: /\bimport unittest\b|\bunittest\.TestCase\b/ },
];

/** Test suites, grouped by their top-level directory so one record describes a suite. */
export function detectTestSuites(ctx, files) {
  const run = new ExtractorRun({
    name: "framework.testing", version: VERSION, exactness: "mixed",
    supports: TEST_FRAMEWORKS.map((f) => f.name),
  });

  const suites = new Map();
  for (const file of files) {
    if (file.kind !== "test") continue;
    run.consider();
    const text = ctx.contents.get(file.path) ?? "";
    const frameworks = TEST_FRAMEWORKS.filter((f) => f.pattern.test(text)).map((f) => f.name);
    // tests/unit/... -> tests/unit; tests/x.py -> tests
    const parts = file.path.split("/");
    const suiteKey = parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0];
    const id = detectionId("suite", suiteKey);
    if (!suites.has(id)) {
      suites.set(id, {
        id, detector: run.name, confidence: "high", evidenceIds: [],
        name: suiteKey, kind: inferSuiteKind(suiteKey),
        paths: [suiteKey], fileCount: 0, frameworks: new Set(),
      });
    }
    const suite = suites.get(id);
    suite.fileCount += 1;
    frameworks.forEach((f) => suite.frameworks.add(f));
    if (suite.evidenceIds.length < 3) {
      const evId = ctx.evidence.add({
        path: file.path, lineStart: 1, lineEnd: Math.min(10, file.lineCount ?? 1),
        detail: `declares tests in the ${suiteKey} suite`, sourceText: text, region: "suite",
      });
      if (evId) suite.evidenceIds.push(evId);
    }
    run.emitted();
  }

  return {
    testSuites: [...suites.values()]
      .map((s) => ({ ...s, frameworks: [...s.frameworks].sort() }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    provenance: run.finish(),
  };
}

function inferSuiteKind(key) {
  if (/e2e|end-to-end|acceptance/i.test(key)) return "e2e";
  if (/integration|it\b/i.test(key)) return "integration";
  if (/unit/i.test(key)) return "unit";
  return "unspecified";
}

/**
 * Configuration sources and the keys they read. A key's *presence* is static; its
 * value in any environment is not, and is never recorded here.
 */
export function detectConfiguration(ctx, files) {
  const run = new ExtractorRun({
    name: "framework.configuration", version: VERSION, exactness: "mixed",
    supports: ["dotenv", "settings-module", "yaml-config"],
  });

  const sources = [];
  const keys = new Map();

  for (const file of files) {
    const base = path.basename(file.path);
    const text = ctx.contents.get(file.path);
    if (text === undefined) continue;

    const isDotenv = base.startsWith(".env");
    const isSettings = /(^|\/)(settings|config)\.(py|ts|js|mjs)$/.test(file.path);
    const isYamlConfig = /(^|\/)configs?\//.test(file.path) && /\.ya?ml$/.test(base);

    if (isDotenv || isSettings || isYamlConfig) {
      run.consider();
      const evId = ctx.evidence.add({
        path: file.path, lineStart: 1, lineEnd: Math.min(15, file.lineCount ?? 1),
        detail: "declares a configuration source", sourceText: text, region: "config-source",
      });
      sources.push({
        id: detectionId("cfgsrc", file.path),
        detector: run.name, confidence: "high", evidenceIds: [evId].filter(Boolean),
        name: base, path: file.path,
        kind: isDotenv ? "dotenv" : isSettings ? "settings-module" : "yaml",
      });
      run.emitted();
    }

    // Environment reads anywhere in the tree: os.getenv / process.env / env.get
    const patterns = [
      /\bos\.getenv\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g,
      /\bos\.environ(?:\.get)?\(?\s*\[?\s*["']([A-Z][A-Z0-9_]{2,})["']/g,
      /\bprocess\.env\.([A-Z][A-Z0-9_]{2,})\b/g,
      /\bprocess\.env\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\]/g,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const name = match[1];
        const line = text.slice(0, match.index).split("\n").length;
        const id = detectionId("cfgkey", name);
        if (!keys.has(id)) {
          const evId = ctx.evidence.add({
            path: file.path, lineStart: line, lineEnd: line,
            detail: `reads the configuration key ${name}`, sourceText: text, region: `key-${name}`,
          });
          keys.set(id, {
            id, detector: run.name, confidence: "high", evidenceIds: [evId].filter(Boolean),
            name, readAtPaths: [], valueType: "string",
            // Name-shape signal only. Whether it is truly a secret is semantic.
            looksSecretByName: /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE)/.test(name),
          });
          run.emitted();
        }
        const key = keys.get(id);
        if (!key.readAtPaths.includes(file.path)) key.readAtPaths.push(file.path);
      }
    }
  }

  return {
    configurationSources: sources.sort((a, b) => (a.id < b.id ? -1 : 1)),
    configurationKeys: [...keys.values()]
      .map((k) => ({ ...k, readAtPaths: k.readAtPaths.sort() }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    provenance: run.finish(),
  };
}

const OBSERVABILITY_SIGNALS = [
  { kind: "tracing", name: "OpenTelemetry", pattern: /\bopentelemetry\b|\bTracerProvider\b|\btrace\.get_tracer\b/i },
  { kind: "metrics", name: "Prometheus", pattern: /\bprometheus_client\b|\bprom-client\b|\bCounter\(|\bmake_asgi_app\b/ },
  { kind: "logging", name: "Structured logging", pattern: /\bstructlog\b|\bwinston\b|\bpino\b|\blogging\.getLogger\b/ },
  { kind: "error-reporting", name: "Sentry", pattern: /\bsentry_sdk\b|@sentry\// },
];

export function detectObservability(ctx) {
  const run = new ExtractorRun({
    name: "framework.observability", version: VERSION, exactness: "heuristic",
    supports: OBSERVABILITY_SIGNALS.map((s) => s.name),
  });
  const found = new Map();
  for (const [relPath, text] of ctx.contents) {
    for (const signal of OBSERVABILITY_SIGNALS) {
      const pattern = new RegExp(signal.pattern.source, signal.pattern.flags.replace("g", ""));
      const match = pattern.exec(text);
      if (!match) continue;
      run.consider();
      const line = text.slice(0, match.index).split("\n").length;
      const id = detectionId("obs", signal.name);
      if (!found.has(id)) {
        found.set(id, {
          id, detector: run.name, confidence: "medium", evidenceIds: [],
          name: signal.name, kind: signal.kind, definitionPaths: [],
        });
        run.emitted();
      }
      const record = found.get(id);
      if (record.definitionPaths.length < 5) {
        const evId = ctx.evidence.add({
          path: relPath, lineStart: line, lineEnd: line,
          detail: `initializes ${signal.name}`, sourceText: text, region: `obs-${signal.name}`,
        });
        if (evId) record.evidenceIds.push(evId);
        record.definitionPaths.push(relPath);
      }
    }
  }
  return {
    observability: [...found.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    provenance: run.finish(),
  };
}
