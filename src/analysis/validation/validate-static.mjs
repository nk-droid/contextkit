/**
 * Static-artifact validation.
 *
 * Structural checks confirm required shape; semantic checks confirm the artifact is
 * internally coherent - every reference resolves, every evidence line range fits its
 * file, and every id is unique. A failure here must stop publication rather than be
 * carried into the semantic stage, because later stages inherit every error.
 */
import { ID_PATTERN } from "../stable-ids.mjs";

const REQUIRED_TOP_LEVEL = [
  "schemaVersion", "artifactId", "scanner", "repository", "inspection",
  "inventory", "code", "detections", "evidence", "sourceIndex", "diagnostics",
];

const DETECTION_COLLECTIONS = [
  "technologies", "dependencies", "entrypoints", "apiSurfaces", "dataContracts",
  "dataStores", "dataEntities", "migrations", "prerequisites", "commands",
  "configurationSources", "configurationKeys", "testSuites", "buildArtifacts",
  "workflows", "deploymentTargets", "observability", "externalSystems", "routes",
];

export function validateStaticDocument(doc) {
  const errors = [];
  const warnings = [];
  const fail = (message) => errors.push(message);

  // --- structural -----------------------------------------------------------
  for (const key of REQUIRED_TOP_LEVEL) {
    if (!(key in doc)) fail(`missing required top-level key: ${key}`);
  }
  if (errors.length) return { valid: false, errors, warnings };

  if (doc.schemaVersion !== 1) fail(`unsupported schemaVersion: ${doc.schemaVersion}`);
  if (!ID_PATTERN.test(doc.artifactId)) fail(`artifactId is not a valid identifier: ${doc.artifactId}`);
  if (!doc.repository.treeFingerprint) fail("repository.treeFingerprint is required");
  for (const key of DETECTION_COLLECTIONS) {
    if (!Array.isArray(doc.detections[key])) fail(`detections.${key} must be an array`);
  }

  // --- identifier uniqueness ------------------------------------------------
  const seen = new Map();
  const claim = (id, where) => {
    if (!id) return;
    if (!ID_PATTERN.test(id)) fail(`invalid identifier ${id} in ${where}`);
    if (seen.has(id)) fail(`duplicate id ${id} in ${where} (first seen in ${seen.get(id)})`);
    else seen.set(id, where);
  };
  doc.evidence.forEach((e) => claim(e.id, "evidence"));
  doc.code.symbols.forEach((s) => claim(s.id, "code.symbols"));
  doc.code.calls.forEach((c) => claim(c.id, "code.calls"));
  for (const key of DETECTION_COLLECTIONS) {
    (doc.detections[key] ?? []).forEach((r) => claim(r.id, `detections.${key}`));
  }

  // --- evidence integrity ---------------------------------------------------
  const filesByPath = new Map(doc.inventory.files.map((f) => [f.path, f]));
  const evidenceIds = new Set(doc.evidence.map((e) => e.id));
  for (const record of doc.evidence) {
    const file = filesByPath.get(record.path);
    if (!file) {
      fail(`evidence ${record.id} cites ${record.path}, which is not in the inventory`);
      continue;
    }
    if (record.lineEnd < record.lineStart) {
      fail(`evidence ${record.id} has lineEnd before lineStart`);
    }
    if (file.lineCount != null && record.lineEnd > file.lineCount) {
      fail(`evidence ${record.id} ends at line ${record.lineEnd} but ${record.path} has ${file.lineCount} lines`);
    }
    if (record.verificationStatus !== "not-checked") {
      // Only a later verification stage may move this.
      fail(`evidence ${record.id} must leave verificationStatus as not-checked in the static stage`);
    }
    if (record.sensitive && record.excerpt !== null) {
      fail(`evidence ${record.id} is sensitive but still carries excerpt text`);
    }
  }

  // --- reference resolution -------------------------------------------------
  const symbolIds = new Set(doc.code.symbols.map((s) => s.id));
  for (const symbol of doc.code.symbols) {
    if (symbol.parentSymbolId && !symbolIds.has(symbol.parentSymbolId)) {
      fail(`symbol ${symbol.id} references unknown parent ${symbol.parentSymbolId}`);
    }
    if (!filesByPath.has(symbol.path)) {
      fail(`symbol ${symbol.id} cites ${symbol.path}, which is not in the inventory`);
    }
    for (const id of symbol.evidenceIds ?? []) {
      if (!evidenceIds.has(id)) fail(`symbol ${symbol.id} references unknown evidence ${id}`);
    }
  }
  for (const call of doc.code.calls) {
    for (const ref of [call.callerSymbolId, call.calleeSymbolId]) {
      if (!symbolIds.has(ref)) fail(`call ${call.id} references unknown symbol ${ref}`);
    }
    if (!["resolved", "heuristic"].includes(call.resolution)) {
      fail(`call ${call.id} has unsupported resolution ${call.resolution}`);
    }
  }
  for (const key of DETECTION_COLLECTIONS) {
    for (const record of doc.detections[key] ?? []) {
      for (const id of record.evidenceIds ?? []) {
        if (!evidenceIds.has(id)) fail(`detections.${key} record ${record.id} references unknown evidence ${id}`);
      }
    }
  }

  // --- derived-count coherence ---------------------------------------------
  const stats = doc.inspection.statistics;
  if (stats.discoveredFiles !== doc.inventory.files.length) {
    fail(`statistics.discoveredFiles (${stats.discoveredFiles}) does not match the inventory ` +
      `(${doc.inventory.files.length})`);
  }
  const languageFileTotal = doc.inventory.languages.reduce((sum, l) => sum + l.fileCount, 0);
  const classifiedText = doc.inventory.files.filter((f) => f.language && !f.binary).length;
  if (languageFileTotal !== classifiedText) {
    fail(`language statistics cover ${languageFileTotal} files but ${classifiedText} text files carry a language`);
  }

  // --- honest-coverage warnings --------------------------------------------
  const { discoveredCalls, unresolvedCalls } = doc.code.extraction;
  const totalCallSites = discoveredCalls + unresolvedCalls;
  if (totalCallSites > 0 && unresolvedCalls / totalCallSites > 0.5) {
    warnings.push(
      `${unresolvedCalls} of ${totalCallSites} call sites could not be attributed to a declaration ` +
      `in this repository; architecture conclusions drawn from the call graph are correspondingly partial.`,
    );
  }
  if (doc.diagnostics.unsupportedLanguages.length) {
    warnings.push(
      `No semantic adapter ran for: ${doc.diagnostics.unsupportedLanguages.join(", ")}. ` +
      `Those files are inventoried but contribute no declarations.`,
    );
  }
  if (doc.diagnostics.sourceIdentityChanged) {
    warnings.push("Repository identity changed during the scan; re-run before relying on this artifact.");
  }
  if (doc.repository.dirty) {
    warnings.push("Working tree was dirty; the artifact does not describe a committed revision.");
  }

  return { valid: errors.length === 0, errors, warnings };
}
