/**
 * Provider disclosure.
 *
 * States what a provider session can reach before the call is made, and what it actually
 * reached afterwards. Sending repository content to a third party is the one step in
 * ContextKit that leaves the machine, and it should not be the one step that happens
 * silently.
 *
 * The pre-call figure is deliberately a ceiling rather than a prediction. A provider
 * pulls what it wants through tools, so nobody can say in advance what it will read -
 * but the reachable set is exactly known, and a ceiling is the honest number to show
 * someone deciding whether to proceed. The access log then reports what was really
 * touched, so the two can be compared.
 */

const KB = 1024;

function bytes(n) {
  if (n < KB) return `${n} B`;
  if (n < KB * KB) return `${(n / KB).toFixed(0)} KB`;
  return `${(n / KB / KB).toFixed(1)} MB`;
}

/** What this session makes reachable, counted from the loaded run. */
export function describeExposure(store) {
  const doc = store.document;
  const evidence = doc.evidence ?? [];
  const withExcerpt = evidence.filter((e) => e.excerpt);
  const excerptChars = withExcerpt.reduce((sum, e) => sum + e.excerpt.length, 0);
  const redacted = evidence.filter((e) => e.sensitive);
  const detections = Object.values(doc.detections ?? {}).reduce((n, c) => n + c.length, 0);

  const cachedSource = store.sourceIndexLoaded;
  const chunkCount = cachedSource ? store.chunksById.size : (doc.sourceIndex?.chunkCount ?? 0);
  const chunkChars = cachedSource
    ? [...store.chunksById.values()].reduce((sum, c) => sum + (c.content?.length ?? 0), 0)
    : (doc.sourceIndex?.includedBytes ?? 0);

  return {
    repository: doc.repository.name,
    runId: store.runId,
    exposure: cachedSource ? "cached-source" : "static-only",
    files: doc.inventory.files.length,
    symbols: doc.code.symbols.length,
    calls: doc.code.calls.length,
    detections,
    evidenceRecords: evidence.length,
    excerpts: withExcerpt.length,
    excerptChars,
    redactedRecords: redacted.length,
    chunkCount,
    chunkChars,
    withheldChars: cachedSource ? 0 : chunkChars,
  };
}

/**
 * The notice shown before a provider is contacted.
 *
 * Written to be read in two seconds: what leaves, roughly how much, and what does not.
 * The "not sent" half matters as much as the "sent" half - it is the part a reader
 * cannot verify by looking at the command.
 */
export function renderDisclosure(exposure, { provider, model = null, binary = null } = {}) {
  const lines = [
    `Sending repository facts to ${provider}${model ? ` (${model})` : ""}.`,
    "",
    `  repository   ${exposure.repository}  (run ${exposure.runId})`,
    `  policy       ${exposure.exposure}`,
    "",
    "  reachable by the provider:",
    `    ${exposure.files} file paths with sizes, hashes, and languages`,
    `    ${exposure.symbols} declarations with signatures, and ${exposure.calls} call edges`,
    `    ${exposure.detections} detections (routes, dependencies, commands, and so on)`,
    `    ${exposure.excerpts} evidence excerpts - ${bytes(exposure.excerptChars)} of verbatim source`,
  ];

  if (exposure.exposure === "cached-source") {
    lines.push(
      `    ${exposure.chunkCount} cached source chunks - ${bytes(exposure.chunkChars)} of verbatim source`);
  }

  lines.push("", "  not reachable:");
  if (exposure.exposure === "static-only") {
    lines.push(
      `    the source index (${exposure.chunkCount} chunks, ${bytes(exposure.withheldChars)}) - not loaded`);
  }
  lines.push("    the repository filesystem - the provider runs in an empty directory");
  if (exposure.redactedRecords) {
    lines.push(`    ${exposure.redactedRecords} records matched the sensitive-content policy and carry no text`);
  }

  lines.push("",
    "  A provider pulls what it needs, so these are upper bounds, not a prediction.",
    "  What it actually read is reported afterwards.",
    "");
  return lines.join("\n");
}

/** What the provider actually reached, from its own access log. */
export function renderActualAccess(mcpReport) {
  if (!mcpReport) {
    return "  access: no log written - the provider may not have reached the server\n";
  }
  const byName = new Map();
  for (const entry of mcpReport.accessLog ?? []) {
    byName.set(entry.name, (byName.get(entry.name) ?? 0) + 1);
  }
  const parts = [...byName].map(([name, count]) => (count > 1 ? `${name}×${count}` : name));
  return [
    `  actually read: ${mcpReport.calls} calls, ${mcpReport.denied} denied`,
    parts.length ? `    ${parts.join(", ")}` : "",
    "",
  ].filter(Boolean).join("\n");
}
