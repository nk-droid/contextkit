import { RunStore } from "../mcp/run-store.mjs";
import { evidenceId, sha256 } from "../stable-ids.mjs";

/** Reconstruct newly requested evidence from frozen cached source, never trust
 * the model's text or mutate STATIC_ANALYSIS.json. This also works on resume. */
export function checkRequestedEvidence(envelope, store) {
  const records = envelope?.mcpReport?.requestedEvidence ?? [];
  if (!records.length) return { records: [], errors: [] };
  const errors = [];
  const fail = (message) => errors.push({ code: "invalid-requested-evidence", message });
  if (envelope.boundTo?.sourceExposure !== "cached-source") {
    fail("New evidence requires explicit cached-source exposure");
    return { records: [], errors };
  }
  const source = store.sourceIndexLoaded ? store : store.loadedFrom
    ? RunStore.fromDirectory(store.loadedFrom, { includeSourceIndex: true }) : store;
  const accepted = new Map();
  for (const record of records) {
    const file = source.filesByPath.get(record.path);
    const start = record.lineStart, end = record.lineEnd;
    const candidates = source.chunksByPath.get(record.path) ?? [];
    const matches = Number.isInteger(start) && Number.isInteger(end) && end >= start
      && candidates.some((chunk) => {
        if (chunk.sensitive || start < chunk.lineStart || end > chunk.lineEnd) return false;
        const excerpt = chunk.content.split("\n").slice(start - chunk.lineStart, end - chunk.lineStart + 1)
          .filter((line) => line.trim() !== "").join("\n").slice(0, 500);
        return record.excerpt === excerpt && record.excerptSha256 === (excerpt ? sha256(excerpt) : null)
          && record.id === evidenceId(record.path, `req-${start}-${end}`, excerpt || `${record.path}:${start}`);
      });
    if (!file || file.sha256 !== record.fileSha256 || record.sensitive !== false || !matches) {
      fail(`Requested evidence ${record.id} does not match the frozen source cache`);
    } else accepted.set(record.id, record);
  }
  return { records: [...accepted.values()], errors };
}
