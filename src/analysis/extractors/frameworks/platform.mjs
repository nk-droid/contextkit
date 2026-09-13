/**
 * Platform and contract detectors.
 *
 * Covers Cloudflare bindings and worker entrypoints, declared package executables,
 * and schema-derived data contracts. Technologies are rolled up from what other
 * extractors already established rather than sniffed a second time, so the two can
 * never disagree.
 */
import path from "node:path";
import { detectionId } from "../../stable-ids.mjs";
import { ExtractorRun } from "../extractor.mjs";

const VERSION = "1.0.0";

/** wrangler config: bindings are declared infrastructure, not inferred. */
export function detectPlatform(ctx, files) {
  const run = new ExtractorRun({
    name: "framework.platform", version: VERSION, exactness: "mixed",
    supports: ["wrangler", "cloudflare-bindings", "package-bin"],
  });
  const deploymentTargets = [];
  const externalSystems = [];

  for (const file of files) {
    const base = path.basename(file.path);
    const text = ctx.contents.get(file.path);
    if (text === undefined) continue;

    if (/^wrangler\.(toml|jsonc?|ya?ml)$/.test(base)) {
      run.consider();
      const evId = ctx.evidence.add({
        path: file.path, lineStart: 1, lineEnd: Math.min(25, file.lineCount ?? 1),
        detail: "declares the Cloudflare Worker deployment configuration",
        sourceText: text, region: "wrangler",
      });
      const bindings = [];
      for (const [label, pattern] of [
        ["d1", /\bd1_databases\b/], ["kv", /\bkv_namespaces\b/], ["r2", /\br2_buckets\b/],
        ["queue", /\bqueues\b/], ["durable-object", /\bdurable_objects\b/],
      ]) {
        if (pattern.test(text)) bindings.push(label);
      }
      deploymentTargets.push({
        id: detectionId("deploy", file.path),
        detector: run.name, confidence: "high", evidenceIds: [evId].filter(Boolean),
        name: "Cloudflare Workers", kind: "serverless-platform",
        definitionPaths: [file.path], bindings,
      });
      run.emitted();
      for (const binding of bindings) {
        externalSystems.push({
          id: detectionId("ext", "cloudflare", binding),
          detector: run.name, confidence: "high", evidenceIds: [evId].filter(Boolean),
          name: `Cloudflare ${binding.toUpperCase()}`, kind: "platform-binding",
          sourcePath: file.path,
        });
      }
      continue;
    }

    // Declared package executables are real entrypoints a user can invoke.
    if (base === "package.json") {
      try {
        const pkg = JSON.parse(text);
        for (const [name, target] of Object.entries(pkg.bin ?? {})) {
          run.consider();
          const evId = ctx.evidence.add({
            path: file.path, lineStart: 1, lineEnd: Math.min(20, file.lineCount ?? 1),
            detail: `declares the executable ${name}`, sourceText: text, region: `bin-${name}`,
          });
          externalSystems.push({
            id: detectionId("bin", file.path, name),
            detector: run.name, confidence: "high", evidenceIds: [evId].filter(Boolean),
            name, kind: "declared-executable", target: String(target), sourcePath: file.path,
          });
          run.emitted();
        }
      } catch { /* the npm extractor already reported the parse failure */ }
    }
  }

  return {
    deploymentTargets: deploymentTargets.sort((a, b) => (a.id < b.id ? -1 : 1)),
    externalSystems: externalSystems.sort((a, b) => (a.id < b.id ? -1 : 1)),
    provenance: run.finish(),
  };
}

/** Schema declarations that cross a process boundary: zod, pydantic, JSON Schema. */
export function detectDataContracts(ctx, symbols) {
  const run = new ExtractorRun({
    name: "framework.contracts", version: VERSION, exactness: "heuristic",
    supports: ["zod", "pydantic", "json-schema"],
  });
  const contracts = [];

  for (const [relPath, text] of ctx.contents) {
    if (/\bz\.object\s*\(/.test(text)) {
      for (const match of text.matchAll(/\b(?:export\s+)?const\s+([A-Za-z_]\w*)\s*=\s*z\.object\s*\(/g)) {
        run.consider();
        const line = text.slice(0, match.index).split("\n").length;
        const evId = ctx.evidence.add({
          path: relPath, lineStart: line, lineEnd: line,
          detail: `declares the zod schema ${match[1]}`, sourceText: text, region: `zod-${match[1]}`,
        });
        contracts.push({
          id: detectionId("contract", relPath, match[1]),
          detector: run.name, confidence: "medium", evidenceIds: [evId].filter(Boolean),
          name: match[1], kind: "zod-schema", definitionPath: relPath, lineStart: line,
        });
        run.emitted();
      }
    }
    if (/\bBaseModel\b/.test(text)) {
      for (const match of text.matchAll(/class\s+([A-Za-z_]\w*)\s*\([^)]*\bBaseModel\b[^)]*\)/g)) {
        run.consider();
        const line = text.slice(0, match.index).split("\n").length;
        const evId = ctx.evidence.add({
          path: relPath, lineStart: line, lineEnd: line,
          detail: `declares the pydantic model ${match[1]}`, sourceText: text, region: `pydantic-${match[1]}`,
        });
        contracts.push({
          id: detectionId("contract", relPath, match[1]),
          detector: run.name, confidence: "medium", evidenceIds: [evId].filter(Boolean),
          name: match[1], kind: "pydantic-model", definitionPath: relPath, lineStart: line,
        });
        run.emitted();
      }
    }
    if (path.extname(relPath) === ".json" && /"\$schema"\s*:/.test(text)) {
      run.consider();
      const evId = ctx.evidence.add({
        path: relPath, lineStart: 1, lineEnd: Math.min(10, ctx.lineCount(relPath) ?? 1),
        detail: "declares a JSON Schema document", sourceText: text, region: "json-schema",
      });
      contracts.push({
        id: detectionId("contract", relPath),
        detector: run.name, confidence: "high", evidenceIds: [evId].filter(Boolean),
        name: path.basename(relPath), kind: "json-schema", definitionPath: relPath, lineStart: 1,
      });
      run.emitted();
    }
  }
  void symbols;
  return { dataContracts: contracts.sort((a, b) => (a.id < b.id ? -1 : 1)), provenance: run.finish() };
}

/**
 * Roll technologies up from facts other extractors already established: declared
 * dependencies, prerequisites, detected stores, and observed languages. Deriving
 * rather than re-sniffing means the technology list cannot contradict them.
 */
export function rollUpTechnologies(ctx, { dependencies, prerequisites, dataStores, languages }) {
  const run = new ExtractorRun({
    name: "derive.technologies", version: VERSION, exactness: "exact",
    supports: ["dependencies", "prerequisites", "stores", "languages"],
  });

  const KNOWN = new Map(Object.entries({
    fastapi: "framework", flask: "framework", django: "framework", express: "framework",
    next: "framework", react: "framework", vue: "framework", svelte: "framework",
    langchain: "framework", langgraph: "framework", ray: "framework", celery: "framework",
    sqlalchemy: "library", "drizzle-orm": "library", prisma: "library", zod: "library",
    pydantic: "library", typescript: "language-tooling", vitest: "test-framework",
    jest: "test-framework", pytest: "test-framework", ruff: "quality-tool",
    eslint: "quality-tool", mypy: "quality-tool", bandit: "quality-tool",
    uvicorn: "server", gunicorn: "server", redis: "client-library",
    "opentelemetry-api": "observability", "prometheus-client": "observability",
  }));

  const records = new Map();
  const add = (name, category, version, evidenceIds, sourcePath) => {
    const id = detectionId("tech", name);
    if (records.has(id)) return;
    records.set(id, {
      id, detector: run.name, confidence: "high", evidenceIds: evidenceIds ?? [],
      name, category, version: version ?? null, sourcePath: sourcePath ?? null,
    });
    run.emitted();
  };

  for (const language of languages) {
    if (language.fileCount >= 2) add(language.language, "language", null, [], null);
  }
  for (const prerequisite of prerequisites) {
    add(prerequisite.name, "runtime", prerequisite.versionConstraint, prerequisite.evidenceIds, prerequisite.sourcePath);
  }
  for (const store of dataStores) {
    add(store.technology ?? store.name, "data-store", null, store.evidenceIds, null);
  }
  for (const dependency of dependencies) {
    run.consider();
    const key = dependency.name.toLowerCase().replace(/^@[^/]+\//, "");
    const category = KNOWN.get(key) ?? KNOWN.get(dependency.name.toLowerCase());
    if (!category) continue;
    add(dependency.name, category, dependency.versionConstraint, dependency.evidenceIds, dependency.sourcePath);
  }
  void ctx;

  return {
    technologies: [...records.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
    provenance: run.finish(),
  };
}
