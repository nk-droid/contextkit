/**
 * Manifest and ecosystem extractors.
 *
 * Each extractor emits typed detection records rather than a generic property bag, so
 * a schema failure names the thing that is wrong. Every record carries the detector
 * that produced it, a confidence, and the evidence ids backing it.
 *
 * These extractors record what a manifest *declares*. Whether a declared command is
 * ever run, or a dependency actually used, is a semantic question for a later stage.
 */
import path from "node:path";
import { detectionId } from "../stable-ids.mjs";
import { ExtractorRun } from "./extractor.mjs";

const VERSION = "1.0.0";

function lineOf(text, needle, fromIndex = 0) {
  const at = text.indexOf(needle, fromIndex);
  if (at < 0) return null;
  return text.slice(0, at).split("\n").length;
}

/** package.json: packages, scripts, dependencies, engines, package manager. */
function npmExtractor(ctx) {
  const run = new ExtractorRun({
    name: "manifest.npm", version: VERSION, exactness: "exact",
    supports: ["package.json"],
  });
  const out = { technologies: [], dependencies: [], commands: [], prerequisites: [], manifests: [] };

  for (const [relPath, text] of ctx.contents) {
    if (path.basename(relPath) !== "package.json") continue;
    if (relPath.includes("node_modules/")) continue;
    run.consider();
    let pkg;
    try {
      pkg = JSON.parse(text);
    } catch (error) {
      run.fail(relPath, `invalid JSON: ${error.message}`);
      continue;
    }
    run.parsed();

    const evidence = ctx.evidence.add({
      path: relPath, lineStart: 1, lineEnd: Math.min(30, ctx.lineCount(relPath) ?? 1),
      detail: "declares the npm package manifest", sourceText: text, region: "manifest",
    });

    out.manifests.push({
      id: detectionId("manifest", relPath),
      detector: run.name, confidence: "high", evidenceIds: [evidence].filter(Boolean),
      path: relPath, kind: "npm-package", scope: relPath === "package.json" ? "repository" : "workspace",
      packageName: pkg.name ?? null, declaredVersion: pkg.version ?? null,
    });

    for (const [depKind, field] of [["runtime", "dependencies"], ["development", "devDependencies"],
                                    ["optional", "optionalDependencies"], ["peer", "peerDependencies"]]) {
      for (const [name, constraint] of Object.entries(pkg[field] ?? {})) {
        const line = lineOf(text, `"${name}"`);
        const evId = line ? ctx.evidence.add({
          path: relPath, lineStart: line, lineEnd: line,
          detail: `declares the ${depKind} dependency ${name}`, sourceText: text, region: `dep-${name}`,
        }) : evidence;
        out.dependencies.push({
          id: detectionId("dep", relPath, depKind, name),
          detector: run.name, confidence: "high", evidenceIds: [evId].filter(Boolean),
          name, ecosystem: "npm", kind: depKind, versionConstraint: String(constraint),
          direct: true, sourcePath: relPath,
        });
        run.emitted();
      }
    }

    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      const line = lineOf(text, `"${name}"`, text.indexOf('"scripts"'));
      const evId = line ? ctx.evidence.add({
        path: relPath, lineStart: line, lineEnd: line,
        detail: `declares the npm script ${name}`, sourceText: text, region: `script-${name}`,
      }) : evidence;
      out.commands.push({
        id: detectionId("cmd", relPath, name),
        detector: run.name, confidence: "high", evidenceIds: [evId].filter(Boolean),
        name, command: `npm run ${name}`, rawCommand: String(command),
        category: categorizeCommand(name, String(command)),
        workingDirectory: path.dirname(relPath) === "." ? "." : path.dirname(relPath),
        sourcePath: relPath,
      });
      run.emitted();
    }

    for (const [engine, constraint] of Object.entries(pkg.engines ?? {})) {
      out.prerequisites.push({
        id: detectionId("pre", relPath, engine),
        detector: run.name, confidence: "high", evidenceIds: [evidence].filter(Boolean),
        name: engine, versionConstraint: String(constraint), required: true, sourcePath: relPath,
      });
      run.emitted();
    }
    if (pkg.packageManager) {
      out.technologies.push({
        id: detectionId("tech", "packagemanager", String(pkg.packageManager)),
        detector: run.name, confidence: "high", evidenceIds: [evidence].filter(Boolean),
        name: String(pkg.packageManager).split("@")[0], category: "package-manager",
        version: String(pkg.packageManager).split("@")[1] ?? null, sourcePath: relPath,
      });
      run.emitted();
    }
  }
  return { records: out, provenance: run.finish() };
}

/** pyproject.toml and requirements files. Parsed with a narrow TOML reader, not a regex sweep. */
function pythonExtractor(ctx) {
  const run = new ExtractorRun({
    name: "manifest.python", version: VERSION, exactness: "mixed",
    supports: ["pyproject.toml", "requirements*.txt"],
  });
  const out = { technologies: [], dependencies: [], commands: [], prerequisites: [], manifests: [] };

  for (const [relPath, text] of ctx.contents) {
    const base = path.basename(relPath);
    if (base !== "pyproject.toml" && !/^requirements.*\.txt$/.test(base)) continue;
    run.consider();
    const evidence = ctx.evidence.add({
      path: relPath, lineStart: 1, lineEnd: Math.min(30, ctx.lineCount(relPath) ?? 1),
      detail: `declares the Python ${base === "pyproject.toml" ? "project manifest" : "requirements list"}`,
      sourceText: text, region: "manifest",
    });

    if (base === "pyproject.toml") {
      const nameMatch = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text);
      const requires = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(text);
      out.manifests.push({
        id: detectionId("manifest", relPath),
        detector: run.name, confidence: "high", evidenceIds: [evidence].filter(Boolean),
        path: relPath, kind: "python-project", scope: "repository",
        packageName: nameMatch ? nameMatch[1] : null, declaredVersion: null,
      });
      if (requires) {
        out.prerequisites.push({
          id: detectionId("pre", relPath, "python"),
          detector: run.name, confidence: "high", evidenceIds: [evidence].filter(Boolean),
          name: "Python", versionConstraint: requires[1], required: true, sourcePath: relPath,
        });
        run.emitted();
      }
      // dependency arrays: [project].dependencies and [project.optional-dependencies].*
      for (const block of text.matchAll(/^\s*(?:([a-zA-Z0-9_-]+)\s*=\s*)?\[\s*$([\s\S]*?)^\s*\]/gm)) {
        const body = block[2] ?? "";
        for (const dep of body.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*([^"']*)["']/g)) {
          const line = lineOf(text, dep[0]);
          out.dependencies.push({
            id: detectionId("dep", relPath, block[1] ?? "runtime", dep[1]),
            detector: run.name, confidence: "high",
            evidenceIds: [line ? ctx.evidence.add({
              path: relPath, lineStart: line, lineEnd: line,
              detail: `declares the Python dependency ${dep[1]}`, sourceText: text, region: `dep-${dep[1]}`,
            }) : evidence].filter(Boolean),
            name: dep[1], ecosystem: "pypi",
            kind: block[1] ? "optional" : "runtime",
            // Which extra declared it, so "pytest in the dev extra" stays distinct
            // from the same package declared at runtime.
            dependencyGroup: block[1] ?? null,
            versionConstraint: dep[2].trim() || null, direct: true, sourcePath: relPath,
          });
          run.emitted();
        }
      }
    } else {
      for (const line of text.split("\n")) {
        const match = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*([<>=!~].*)?\s*$/.exec(line);
        if (!match || line.trim().startsWith("#")) continue;
        out.dependencies.push({
          id: detectionId("dep", relPath, "runtime", match[1]),
          detector: run.name, confidence: "high", evidenceIds: [evidence].filter(Boolean),
          name: match[1], ecosystem: "pypi", kind: "runtime",
          versionConstraint: (match[2] ?? "").trim() || null, direct: true, sourcePath: relPath,
        });
        run.emitted();
      }
    }
    run.parsed();
  }
  return { records: out, provenance: run.finish() };
}

/** Make targets are real, declared commands and belong in the operations facts. */
function makeExtractor(ctx) {
  const run = new ExtractorRun({
    name: "manifest.make", version: VERSION, exactness: "exact", supports: ["Makefile"],
  });
  const out = { commands: [] };
  for (const [relPath, text] of ctx.contents) {
    if (!/^(GNU)?[Mm]akefile$/.test(path.basename(relPath))) continue;
    run.consider();
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\s*:(?!=)/.exec(line);
      if (!match || match[1] === ".PHONY") return;
      const body = [];
      for (let j = i + 1; j < lines.length && /^\t/.test(lines[j]); j += 1) body.push(lines[j].trim());
      const evId = ctx.evidence.add({
        path: relPath, lineStart: i + 1, lineEnd: i + 1 + body.length,
        detail: `declares the make target ${match[1]}`, sourceText: text, region: `target-${match[1]}`,
      });
      out.commands.push({
        id: detectionId("cmd", relPath, match[1]),
        detector: run.name, confidence: "high", evidenceIds: [evId].filter(Boolean),
        name: match[1], command: `make ${match[1]}`, rawCommand: body.join(" && ") || null,
        category: categorizeCommand(match[1], body.join(" ")),
        workingDirectory: ".", sourcePath: relPath,
      });
      run.emitted();
    });
    run.parsed();
  }
  return { records: out, provenance: run.finish() };
}

/** Dockerfiles and Compose files: build artifacts and local service topology. */
function containerExtractor(ctx) {
  const run = new ExtractorRun({
    name: "manifest.container", version: VERSION, exactness: "mixed",
    supports: ["Dockerfile", "docker-compose.yml"],
  });
  const out = { buildArtifacts: [], deploymentTargets: [], externalSystems: [] };

  for (const [relPath, text] of ctx.contents) {
    const base = path.basename(relPath);
    if (/dockerfile/i.test(base)) {
      run.consider();
      const fromLine = lineOf(text, "FROM") ?? 1;
      const evId = ctx.evidence.add({
        path: relPath, lineStart: fromLine, lineEnd: Math.min(fromLine + 12, ctx.lineCount(relPath) ?? fromLine),
        detail: "declares a container image build", sourceText: text, region: "dockerfile",
      });
      const baseImage = /^\s*FROM\s+(\S+)/m.exec(text);
      const cmd = /^\s*(?:CMD|ENTRYPOINT)\s+(.+)$/m.exec(text);
      out.buildArtifacts.push({
        id: detectionId("artifact", relPath),
        detector: run.name, confidence: "high", evidenceIds: [evId].filter(Boolean),
        name: base, kind: "container-image", sourcePath: relPath,
        baseImage: baseImage ? baseImage[1] : null,
        startCommand: cmd ? cmd[1].trim() : null,
        // An exact observation; whether running as root is a *risk* is a semantic call.
        declaresNonRootUser: /^\s*USER\s+/m.test(text),
      });
      run.parsed(); run.emitted();
      continue;
    }
    if (/^(docker-)?compose\.ya?ml$/.test(base)) {
      run.consider();
      const evId = ctx.evidence.add({
        path: relPath, lineStart: 1, lineEnd: Math.min(40, ctx.lineCount(relPath) ?? 1),
        detail: "declares the local service topology", sourceText: text, region: "compose",
      });
      out.deploymentTargets.push({
        id: detectionId("deploy", relPath),
        detector: run.name, confidence: "high", evidenceIds: [evId].filter(Boolean),
        name: "Local Docker Compose", kind: "local", definitionPaths: [relPath],
        services: [...text.matchAll(/^ {2}([a-zA-Z0-9._-]+):\s*$/gm)].map((m) => m[1]),
      });
      for (const image of text.matchAll(/^\s*image:\s*["']?([^\s"']+)/gm)) {
        out.externalSystems.push({
          id: detectionId("ext", "image", image[1]),
          detector: run.name, confidence: "medium", evidenceIds: [evId].filter(Boolean),
          name: image[1].split(":")[0], kind: "container-image", reference: image[1], sourcePath: relPath,
        });
      }
      run.parsed(); run.emitted();
    }
  }
  return { records: out, provenance: run.finish() };
}

/** GitHub Actions workflows: triggers, jobs, and whether a workflow can gate a merge. */
function ciExtractor(ctx) {
  const run = new ExtractorRun({
    name: "manifest.github-actions", version: VERSION, exactness: "mixed",
    supports: [".github/workflows/*.yml"],
  });
  const out = { workflows: [] };
  for (const [relPath, text] of ctx.contents) {
    if (!relPath.startsWith(".github/workflows/")) continue;
    run.consider();
    const evId = ctx.evidence.add({
      path: relPath, lineStart: 1, lineEnd: Math.min(30, ctx.lineCount(relPath) ?? 1),
      detail: "declares a CI workflow", sourceText: text, region: "workflow",
    });
    const name = /^\s*name:\s*(.+)$/m.exec(text);
    const onBlock = /^on:\s*([\s\S]*?)^\S/m.exec(text + "\nX");
    const triggers = onBlock
      ? [...onBlock[1].matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1])
      : [...text.matchAll(/^on:\s*\[?([a-z_,\s]+)\]?/gm)].flatMap((m) => m[1].split(/[,\s]+/).filter(Boolean));
    out.workflows.push({
      id: detectionId("wf", relPath),
      detector: run.name, confidence: "medium", evidenceIds: [evId].filter(Boolean),
      name: name ? name[1].trim().replace(/^["']|["']$/g, "") : path.basename(relPath, path.extname(relPath)),
      path: relPath, kind: "ci",
      triggers: [...new Set(triggers)],
      jobs: [...text.matchAll(/^ {2}([a-zA-Z0-9._-]+):\s*$/gm)].map((m) => m[1]),
      // Only a workflow that runs on pull_request or push can gate a change.
      canGateChanges: triggers.some((t) => t === "pull_request" || t === "push"),
    });
    run.parsed(); run.emitted();
  }
  return { records: out, provenance: run.finish() };
}

function categorizeCommand(name, body) {
  const text = `${name} ${body}`.toLowerCase();
  if (/\b(test|pytest|jest|vitest|spec)\b/.test(text)) return "test";
  if (/\b(lint|ruff|eslint|format|fmt|typecheck|tsc|mypy)\b/.test(text)) return "lint";
  if (/\b(bandit|audit|security|pip-audit)\b/.test(text)) return "security";
  if (/\b(build|compile|bundle|docker build)\b/.test(text)) return "build";
  if (/\b(deploy|publish|release)\b/.test(text)) return "deploy";
  if (/\b(dev|start|serve|run|uvicorn|worker)\b/.test(text)) return "run";
  if (/\b(install|ci|sync)\b/.test(text)) return "setup";
  return "other";
}

export const MANIFEST_EXTRACTORS = [
  npmExtractor, pythonExtractor, makeExtractor, containerExtractor, ciExtractor,
];

export function runManifestExtractors(ctx) {
  const detections = {
    technologies: [], dependencies: [], commands: [], prerequisites: [], manifests: [],
    buildArtifacts: [], deploymentTargets: [], externalSystems: [], workflows: [],
  };
  const provenance = [];
  for (const extractor of MANIFEST_EXTRACTORS) {
    const { records, provenance: p } = extractor(ctx);
    provenance.push(p);
    for (const [key, value] of Object.entries(records)) {
      if (Array.isArray(detections[key])) detections[key].push(...value);
    }
  }
  for (const key of Object.keys(detections)) {
    detections[key].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  return { detections, provenance };
}
