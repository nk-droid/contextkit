/**
 * Per-run work directory (plan §6.2).
 *
 * One run, one directory: the static artifact, the private source index, every analysis
 * request and response, and the run report all sit together under the run id. Anything
 * that needs a path asks this module for it, so the layout is defined once rather than
 * assembled from string concatenation at each call site.
 *
 * The directory holds source excerpts, so it follows the confidentiality of the
 * repository it describes and is kept outside that repository by default.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { shortHash } from "./stable-ids.mjs";

const SCAN_BIN = path.resolve(
  path.dirname(new URL(import.meta.url).pathname), "../../bin/contextkit-scan");

export function runIdFor(treeFingerprint) {
  return `run_${shortHash(treeFingerprint, 16)}`;
}

export class RunWorkspace {
  constructor(dir) {
    this.dir = dir;
    this.runId = path.basename(dir);
  }

  get staticPath() { return path.join(this.dir, "STATIC_ANALYSIS.json"); }
  get sourceIndexPath() { return path.join(this.dir, "SOURCE_INDEX.jsonl"); }
  get analysisPlanPath() { return path.join(this.dir, "ANALYSIS_PLAN.json"); }
  get analysisDir() { return path.join(this.dir, "analysis"); }
  get semanticPath() { return path.join(this.dir, "SEMANTIC_ANALYSIS.json"); }
  get candidatePath() { return path.join(this.dir, "CONTEXT_FACTS.candidate.json"); }
  get validationReportPath() { return path.join(this.dir, "validation-report.json"); }
  get runReportPath() { return path.join(this.dir, "run-report.json"); }

  /**
   * Slice artifacts are named `NN-slice.provider.kind.json`.
   *
   * The plan's `01-foundation.request.json` assumes one provider per slice; comparing
   * two providers on the same slice needs the provider in the name too, or the second
   * run silently overwrites the first.
   */
  slicePath(index, sliceId, provider, kind) {
    const prefix = String(index).padStart(2, "0");
    return path.join(this.analysisDir, `${prefix}-${sliceId}.${provider}.${kind}.json`);
  }

  writeSliceArtifact(index, sliceId, provider, kind, payload) {
    fs.mkdirSync(this.analysisDir, { recursive: true });
    const target = this.slicePath(index, sliceId, provider, kind);
    fs.writeFileSync(target, JSON.stringify(payload, null, 2));
    return target;
  }

  /**
   * A working directory for a provider to run in - deliberately OUTSIDE this workspace.
   *
   * It would be tidier under the run directory, and it would also be a hole straight
   * through the access boundary: a provider whose cwd were `<run>/sandbox/claude` could
   * read `../../SOURCE_INDEX.jsonl` and take the entire private source cache off disk,
   * with no tool call, no policy check, and nothing in the access log. The cache and the
   * process allowed to guess at paths do not belong on the same branch of the
   * filesystem, so "one run, one directory" stops at the sandbox.
   */
  createProviderSandbox(provider) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `contextkit-sandbox-${provider}-`));
    fs.writeFileSync(path.join(dir, "README.md"), [
      "# Analysis workspace",
      "",
      "Intentionally empty. The repository under analysis is not on this filesystem,",
      "and neither is ContextKit's source cache. Reach facts through the `contextkit`",
      "MCP server.",
      "",
    ].join("\n"));
    return dir;
  }

  /** Everything the providers touched, assembled from their per-call logs. */
  writeRunReport({ repository, summary, providers }) {
    const report = {
      runId: this.runId,
      repository,
      snapshot: summary,
      generatedAt: new Date().toISOString(),
      providers: providers.map((p) => ({
        provider: p.provider,
        model: p.model ?? null,
        sliceId: p.sliceId,
        ok: p.ok,
        durationMs: p.durationMs,
        usage: p.usage ?? null,
        calls: p.mcpReport?.calls ?? 0,
        denied: p.mcpReport?.denied ?? 0,
        deniedByCode: p.mcpReport?.deniedByCode ?? {},
        accessLog: p.mcpReport?.accessLog ?? [],
      })),
    };
    fs.writeFileSync(this.runReportPath, JSON.stringify(report, null, 2));
    return this.runReportPath;
  }

  describe() {
    const entries = [];
    const walk = (dir, prefix = "") => {
      for (const name of fs.readdirSync(dir).sort()) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full, `${prefix}${name}/`);
        else entries.push({ path: `${prefix}${name}`, bytes: fs.statSync(full).size });
      }
    };
    walk(this.dir);
    return entries;
  }
}

/**
 * Resolve a repository or an existing run into a workspace.
 *
 * The run id comes from the tree fingerprint, which is only known after scanning - so a
 * repository is scanned into a staging directory first and then moved under its id. The
 * alternative, naming the directory before the scan, would mean the directory name and
 * its contents could disagree.
 */
export function ensureRunWorkspace(input, { workRoot = null, quiet = true } = {}) {
  const target = path.resolve(input);
  if (!fs.existsSync(target)) {
    throw new Error(`no such directory: ${target}`);
  }

  const root = workRoot
    ? path.resolve(workRoot)
    : path.join(process.cwd(), ".contextkit", "work");

  // Already a run directory: adopt it where it sits, or move it into place.
  if (fs.existsSync(path.join(target, "STATIC_ANALYSIS.json"))) {
    const document = JSON.parse(fs.readFileSync(path.join(target, "STATIC_ANALYSIS.json"), "utf8"));
    const runId = runIdFor(document.repository.treeFingerprint);
    if (path.basename(target) === runId) return { workspace: new RunWorkspace(target), scanned: false };

    const destination = path.join(root, runId);
    fs.mkdirSync(destination, { recursive: true });
    for (const name of ["STATIC_ANALYSIS.json", "SOURCE_INDEX.jsonl"]) {
      const from = path.join(target, name);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(destination, name));
    }
    return { workspace: new RunWorkspace(destination), scanned: false, adoptedFrom: target };
  }

  const looksLikeRepository = fs.existsSync(path.join(target, ".git"))
    || fs.readdirSync(target).some(
      (f) => ["package.json", "pyproject.toml", "Makefile", "go.mod", "Cargo.toml"].includes(f));
  if (!looksLikeRepository) {
    throw new Error(
      `${target} holds no STATIC_ANALYSIS.json and does not look like a repository`);
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "contextkit-staging-"));
  const scanArgs = [SCAN_BIN, target, "--out", staging];
  if (quiet) scanArgs.push("--quiet");
  const scan = spawnSync(process.execPath, scanArgs, { stdio: ["ignore", "inherit", "inherit"] });
  if (scan.status !== 0) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error("scan failed");
  }

  const document = JSON.parse(fs.readFileSync(path.join(staging, "STATIC_ANALYSIS.json"), "utf8"));
  const destination = path.join(root, runIdFor(document.repository.treeFingerprint));
  fs.mkdirSync(destination, { recursive: true });

  // Move the scan artifacts in without disturbing anything else.
  //
  // Replacing the directory wholesale would be simpler and is wrong: the run id is the
  // tree fingerprint, so re-scanning an unchanged tree yields byte-identical artifacts -
  // there is nothing to replace - while the directory also holds slice responses, entity
  // registries, and run reports that took real time and money to produce. Deleting those
  // to rewrite two files that did not change is pure loss.
  for (const name of ["STATIC_ANALYSIS.json", "SOURCE_INDEX.jsonl"]) {
    const from = path.join(staging, name);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(destination, name));
  }
  fs.rmSync(staging, { recursive: true, force: true });

  return { workspace: new RunWorkspace(destination), scanned: true };
}
