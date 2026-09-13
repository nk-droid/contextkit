/**
 * Human-readable static-analysis report.
 *
 * The plan requires this output be reviewed manually before prompts are built on top
 * of it, so the report leads with coverage and limits rather than with totals: what
 * the scanner could not establish matters more than what it could.
 */
function bar(value, total, width = 24) {
  if (!total) return "".padEnd(width, "·");
  const filled = Math.max(0, Math.min(width, Math.round((value / total) * width)));
  return "█".repeat(filled) + "·".repeat(width - filled);
}

function pct(value, total) {
  return total ? `${Math.round((value / total) * 100)}%` : "0%";
}

export function renderStaticReport(doc, validation) {
  const L = [];
  const stats = doc.inspection.statistics;
  const code = doc.code.extraction;

  L.push(`ContextKit static analysis — ${doc.repository.name}`);
  L.push("=".repeat(64));
  L.push(`artifact      ${doc.artifactId}`);
  L.push(`revision      ${doc.repository.revision ?? "(not a git repository)"}` +
    (doc.repository.dirty ? "  [DIRTY WORKING TREE]" : ""));
  L.push(`fingerprint   ${doc.repository.treeFingerprint.slice(0, 24)}…`);
  L.push(`scanner       ${doc.scanner.name} ${doc.scanner.version} in ${doc.scanner.durationMs} ms`);
  L.push("");

  L.push("COVERAGE");
  L.push(`  files inventoried   ${stats.discoveredFiles}`);
  L.push(`  text / binary       ${stats.textFiles} / ${stats.binaryFiles}`);
  L.push(`  estimated lines     ${stats.estimatedLines.toLocaleString("en-US")}`);
  L.push(`  declarations kept   ${code.retainedSymbols} of ${code.discoveredSymbols} discovered ` +
    `(${pct(code.retainedSymbols, code.discoveredSymbols)})`);
  L.push(`  call edges kept     ${code.retainedCalls} of ${code.discoveredCalls} discovered`);
  const totalSites = code.discoveredCalls + code.unresolvedCalls;
  L.push(`  calls attributed    ${bar(code.discoveredCalls, totalSites)} ` +
    `${code.discoveredCalls}/${totalSites} (${code.unresolvedCalls} unattributed)`);
  L.push("");

  L.push("LANGUAGE ADAPTERS");
  for (const method of code.methods) {
    L.push(`  ${method.available ? "✓" : "✗"} ${method.language.padEnd(20)} ${method.adapter}` +
      (method.interpreter ? ` (${method.interpreter})` : "") +
      (method.available ? "" : "  — NOT AVAILABLE, no declarations extracted"));
  }
  if (doc.diagnostics.unsupportedLanguages.length) {
    L.push(`  ! no adapter for: ${doc.diagnostics.unsupportedLanguages.join(", ")}`);
  }
  L.push("");

  L.push("LANGUAGES BY LINES");
  const topLang = doc.inventory.languages.slice(0, 8);
  const maxLines = Math.max(1, ...topLang.map((l) => l.estimatedLines));
  for (const lang of topLang) {
    L.push(`  ${lang.language.padEnd(20)} ${bar(lang.estimatedLines, maxLines)} ` +
      `${String(lang.estimatedLines).padStart(6)} lines  ${lang.fileCount} files`);
  }
  L.push("");

  L.push("DETECTIONS");
  for (const [key, value] of Object.entries(doc.detections)) {
    if (!value.length) continue;
    L.push(`  ${key.padEnd(20)} ${value.length}`);
  }
  L.push("");

  L.push("EXTRACTORS");
  for (const ex of doc.scanner.extractors) {
    const status = ex.available ? `${ex.recordsEmitted} records` : `UNAVAILABLE`;
    L.push(`  ${ex.name.padEnd(24)} ${String(ex.exactness).padEnd(9)} ` +
      `considered ${String(ex.filesConsidered).padStart(4)}  parsed ${String(ex.filesParsed).padStart(4)}  ${status}`);
    if (!ex.available && ex.unavailableReason) L.push(`      → ${ex.unavailableReason}`);
    if (ex.parseFailureCount) L.push(`      → ${ex.parseFailureCount} parse failures`);
  }
  L.push("");

  L.push("EVIDENCE & SOURCE INDEX");
  L.push(`  evidence records    ${doc.evidence.length}`);
  L.push(`  rejected citations  ${doc.diagnostics.rejectedEvidence.length}`);
  L.push(`  source chunks       ${doc.sourceIndex.chunkCount} ` +
    `(${doc.sourceIndex.excludedSensitiveChunks} sensitive, content withheld)`);
  L.push(`  index bytes         ${doc.sourceIndex.includedBytes.toLocaleString("en-US")}`);
  L.push("");

  L.push(`VALIDATION: ${validation.valid ? "PASS" : "FAIL"}`);
  for (const error of validation.errors) L.push(`  ERROR   ${error}`);
  for (const warning of [...validation.warnings, ...doc.diagnostics.warnings]) {
    L.push(`  WARNING ${warning}`);
  }
  if (validation.valid && !validation.warnings.length && !doc.diagnostics.warnings.length) {
    L.push("  no warnings");
  }
  L.push("");
  L.push("This is a static diagnostic artifact. It records what tools can establish");
  L.push("directly and deliberately contains no semantic interpretation.");
  return L.join("\n");
}
