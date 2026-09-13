/**
 * Static-analysis orchestrator.
 *
 * This is the only stage permitted to read the target repository. It acquires a
 * snapshot, inventories it, runs every extractor against the cached contents, builds
 * canonical evidence and the private source index, and emits STATIC_ANALYSIS.json.
 *
 * It deliberately produces a *diagnostic* artifact, not a half-filled final facts
 * document: no field here is padded with "Unknown" prose to look complete.
 */
import { acquireSource, computeTreeFingerprint, recheckSourceIdentity } from "./acquire-source.mjs";
import { buildSourceIndex } from "./build-source-index.mjs";
import { EvidenceRegistry } from "./evidence-registry.mjs";
import { DEFAULT_LIMITS, POLICY_VERSION } from "./policy.mjs";
import { byId, callId, sha256, shortHash, slug } from "./stable-ids.mjs";
import {
  buildInventory, deriveDirectories, inventoryStatistics, summarizeLanguages,
} from "./extractors/filesystem.mjs";
import { runManifestExtractors } from "./extractors/manifests.mjs";
import { extractTypeScript } from "./extractors/languages/typescript.mjs";
import { extractPython } from "./extractors/languages/python.mjs";
import { detectRoutes } from "./extractors/frameworks/routes.mjs";
import { detectStorage } from "./extractors/frameworks/storage.mjs";
import { detectConfiguration, detectObservability, detectTestSuites } from "./extractors/frameworks/testing.mjs";
import { detectDataContracts, detectPlatform, rollUpTechnologies } from "./extractors/frameworks/platform.mjs";

export const SCANNER_NAME = "contextkit-static";
export const SCANNER_VERSION = "0.1.0";

/**
 * Deterministic retention, ordered by the priorities in the analysis plan. A model
 * never chooses the initial symbol set, because that would make the source graph
 * irreproducible between runs.
 */
function retainSymbols(symbols, calls, limits) {
  const degree = new Map();
  for (const call of calls) {
    degree.set(call.callerSymbolId, (degree.get(call.callerSymbolId) ?? 0) + 1);
    degree.set(call.calleeSymbolId, (degree.get(call.calleeSymbolId) ?? 0) + 1);
  }
  const priority = (s) => {
    if (s.isEntrypoint) return 0;                                  // process/framework entrypoints
    if (s.kind === "class") return 1;
    if (s.exported) return 2;                                      // public declarations
    if ((degree.get(s.id) ?? 0) >= 3) return 3;                    // high-degree call-graph nodes
    if (/store|auth|config|error|migrat|queue|client/i.test(s.name)) return 4;
    return 5;
  };
  const ranked = [...symbols].sort((a, b) =>
    priority(a) - priority(b) ||
    (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
    (a.id < b.id ? -1 : 1));
  const kept = new Set(ranked.slice(0, limits.maxRetainedSymbols).map((s) => s.id));
  // Keep a retained method's declaring class so the tree stays whole.
  for (const symbol of symbols) {
    if (kept.has(symbol.id) && symbol.parentSymbolId) kept.add(symbol.parentSymbolId);
  }
  return kept;
}

export function scanRepository(rootInput, options = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) };
  const startedAt = new Date();
  const t0 = Date.now();

  // 1. Freeze source identity.
  const { identity, files: candidates, exclusions, warnings } = acquireSource(rootInput, {
    allowUntracked: options.allowUntracked ?? false,
  });

  // 2. Inventory. Contents are cached here so no extractor reopens a file.
  const inventory = buildInventory(identity.root, candidates, limits);
  const { files, contents } = inventory;
  const provenance = [inventory.provenance];

  const fingerprint = computeTreeFingerprint(files);

  const inventoryByPath = new Map(files.map((f) => [f.path, f]));
  const evidence = new EvidenceRegistry(inventoryByPath, limits);

  const ctx = {
    root: identity.root,
    contents,
    evidence,
    limits,
    moduleImports: new Map(),
    lineCount: (p) => inventoryByPath.get(p)?.lineCount ?? null,
    file: (p) => inventoryByPath.get(p) ?? null,
  };

  // 3. Manifests and ecosystem facts.
  const manifestResult = runManifestExtractors(ctx);
  provenance.push(...manifestResult.provenance);

  // 4. Language adapters.
  const tsResult = extractTypeScript(ctx);
  const pyResult = extractPython(ctx);
  provenance.push(tsResult.provenance, pyResult.provenance);

  const allSymbols = [...tsResult.symbols, ...pyResult.symbols].sort(byId);
  const allCalls = [...tsResult.calls, ...pyResult.calls];
  const unresolvedCalls = tsResult.unresolvedCalls + pyResult.unresolvedCalls;

  // 5. Deterministic retention.
  const keptIds = retainSymbols(allSymbols, allCalls, limits);
  const symbols = allSymbols.filter((s) => keptIds.has(s.id)).map((s) => ({
    ...s,
    parentSymbolId: s.parentSymbolId && keptIds.has(s.parentSymbolId) ? s.parentSymbolId : null,
  }));
  const calls = allCalls
    .filter((c) => keptIds.has(c.callerSymbolId) && keptIds.has(c.calleeSymbolId))
    .map((c, i) => ({
      id: callId(c.callerSymbolId, c.calleeSymbolId, i),
      callerSymbolId: c.callerSymbolId,
      calleeSymbolId: c.calleeSymbolId,
      callSiteLines: [...new Set(c.lines)].sort((a, b) => a - b).slice(0, 12),
      resolution: c.resolution,
    }))
    .sort(byId);

  // Evidence for every retained declaration, created by the scanner alone.
  const symbolsByPath = new Map();
  for (const symbol of symbols) {
    const text = contents.get(symbol.path);
    const evId = evidence.add({
      path: symbol.path,
      lineStart: symbol.lineStart,
      lineEnd: Math.min(symbol.lineEnd, symbol.lineStart + 18),
      symbol: symbol.name,
      region: symbol.qualifiedName,
      detail: `declares ${symbol.kind} ${symbol.name}`,
      sourceText: text ?? "",
    });
    symbol.evidenceIds = evId ? [evId] : [];
    if (!symbolsByPath.has(symbol.path)) symbolsByPath.set(symbol.path, []);
    symbolsByPath.get(symbol.path).push(symbol);
  }

  // 6. Framework detectors. These run after symbols exist so a route can be tied to
  // the declaration that implements it.
  const routeResult = detectRoutes(ctx, symbols);
  const storageResult = detectStorage(ctx);
  const testResult = detectTestSuites(ctx, files);
  const configResult = detectConfiguration(ctx, files);
  const obsResult = detectObservability(ctx);
  const platformResult = detectPlatform(ctx, files);
  const contractResult = detectDataContracts(ctx, symbols);
  provenance.push(
    routeResult.provenance, storageResult.provenance, testResult.provenance,
    configResult.provenance, obsResult.provenance, platformResult.provenance,
    contractResult.provenance,
  );

  const techResult = rollUpTechnologies(ctx, {
    dependencies: manifestResult.detections.dependencies,
    prerequisites: manifestResult.detections.prerequisites,
    dataStores: storageResult.dataStores,
    languages: summarizeLanguages(files),
  });
  provenance.push(techResult.provenance);

  // 7. Private source index.
  const sourceIndex = buildSourceIndex({ files, contents, symbolsByPath }, limits);

  // 8. Confirm the tree did not move while we were reading it.
  const recheck = recheckSourceIdentity(identity);
  if (recheck.changed) {
    warnings.push("Repository changed during the scan; this snapshot may not be coherent.");
  }

  const languages = summarizeLanguages(files);
  const statistics = inventoryStatistics(files);
  const inspectedFiles = files.filter((f) => symbolsByPath.has(f.path) || contents.has(f.path)).length;

  const unsupportedLanguages = [...new Set(
    files.filter((f) => f.language && !f.binary &&
      !["TypeScript", "TypeScript/React", "JavaScript", "JavaScript/React", "Python"].includes(f.language) &&
      f.kind === "source")
      .map((f) => f.language),
  )].sort();

  const configurationFingerprint = sha256(JSON.stringify({
    policy: POLICY_VERSION, scanner: SCANNER_VERSION, limits,
  }));

  const completedAt = new Date();
  const document = {
    schemaVersion: 1,
    artifactId: `static.${slug(identity.name)}.${shortHash(fingerprint, 12)}`,
    scanner: {
      name: SCANNER_NAME,
      version: SCANNER_VERSION,
      configurationFingerprint,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Date.now() - t0,
      extractors: provenance,
    },
    repository: {
      id: `repo.${slug(identity.name)}`,
      name: identity.name,
      sourceKind: identity.sourceKind,
      mode: identity.mode,
      revision: identity.revision,
      revisionKind: identity.revisionKind,
      defaultBranch: identity.defaultBranch,
      canonicalRemote: identity.canonicalRemote,
      dirty: identity.dirty,
      shallow: identity.shallow,
      submodulesPresent: identity.submodulesPresent,
      gitLfsPresent: identity.gitLfsPresent,
      treeFingerprint: fingerprint,
    },
    inspection: {
      status: unsupportedLanguages.length ? "partial" : "complete",
      mode: identity.mode,
      exclusions,
      limits: Object.entries(limits).map(([name, value]) => ({
        name, configuredValue: String(value), reached: false,
      })),
      statistics: { ...statistics, inspectedFiles },
    },
    inventory: {
      files,
      directories: deriveDirectories(files),
      languages,
      manifests: manifestResult.detections.manifests,
    },
    code: {
      extraction: {
        performed: symbols.length > 0,
        methods: [
          { language: "TypeScript", adapter: "typescript-compiler-api", available: tsResult.provenance.available },
          { language: "Python", adapter: "python-ast", available: pyResult.provenance.available,
            interpreter: pyResult.interpreter ?? null },
        ],
        discoveredSymbols: allSymbols.length,
        discoveredCalls: allCalls.length,
        retainedSymbols: symbols.length,
        retainedCalls: calls.length,
        retentionRule:
          `Ordered by entrypoints, classes, exported declarations, call-graph degree, then ` +
          `storage/auth/config/error declarations, capped at ${limits.maxRetainedSymbols} symbols.`,
        unresolvedCalls,
      },
      symbols,
      calls,
      imports: [...tsResult.imports, ...pyResult.imports]
        .sort((a, b) => (a.fromPath < b.fromPath ? -1 : a.fromPath > b.fromPath ? 1 : a.lineStart - b.lineStart)),
    },
    detections: {
      technologies: [...manifestResult.detections.technologies, ...techResult.technologies]
        .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i)
        .sort(byId),
      dependencies: manifestResult.detections.dependencies,
      entrypoints: symbols.filter((s) => s.isEntrypoint).map((s) => ({
        id: `ep.${s.id}`, detector: s.detector, confidence: "medium",
        evidenceIds: s.evidenceIds ?? [], name: s.name, path: s.path,
        symbol: s.name, lineStart: s.lineStart,
      })),
      apiSurfaces: routeResult.apiSurfaces,
      routes: routeResult.routes,
      dataContracts: contractResult.dataContracts,
      dataStores: storageResult.dataStores,
      dataEntities: storageResult.dataEntities,
      migrations: storageResult.migrations,
      prerequisites: manifestResult.detections.prerequisites,
      commands: manifestResult.detections.commands,
      configurationSources: configResult.configurationSources,
      configurationKeys: configResult.configurationKeys,
      testSuites: testResult.testSuites,
      buildArtifacts: manifestResult.detections.buildArtifacts,
      workflows: manifestResult.detections.workflows,
      deploymentTargets: [...manifestResult.detections.deploymentTargets, ...platformResult.deploymentTargets]
        .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i)
        .sort(byId),
      observability: obsResult.observability,
      externalSystems: [...manifestResult.detections.externalSystems, ...platformResult.externalSystems]
        .filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i)
        .sort(byId),
    },
    evidence: evidence.all(),
    sourceIndex: sourceIndex.summary,
    diagnostics: {
      warnings,
      errors: [],
      unsupportedLanguages,
      unresolvedImports: 0,
      unresolvedCalls,
      rejectedEvidence: evidence.rejected.slice(0, 25),
      sourceIdentityChanged: recheck.changed,
    },
  };

  return { document, sourceIndex };
}
