/**
 * Frozen run store.
 *
 * Loads one completed scan - STATIC_ANALYSIS.json plus SOURCE_INDEX.jsonl - into an
 * indexed, read-only view. This is the only thing the MCP server can see: once a run
 * is loaded the repository is never consulted again, which is what makes "one
 * repository lookup" enforceable rather than merely intended.
 *
 * Runs are addressed by an opaque id derived from the tree fingerprint, so a provider
 * never learns a host path.
 */
import fs from "node:fs";
import path from "node:path";
import { shortHash } from "../stable-ids.mjs";

/**
 * Object.freeze is shallow, which would leave every nested record writable - and "the
 * provider cannot mutate static artifacts" has to hold for `document.repository.name`
 * just as much as for `document`. Records are returned to callers by reference, so the
 * freeze has to reach all the way down.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) deepFreeze(value[key]);
  return value;
}

export class RunStore {
  constructor(document, chunks, { loadedFrom = null, sourceIndexLoaded = null } = {}) {
    this.document = deepFreeze(document);
    this.runId = `run_${shortHash(document.repository.treeFingerprint, 16)}`;
    this.loadedFrom = loadedFrom;
    // Whether this session holds cached source at all. Null means "not stated", which
    // callers read as: it holds whatever chunks it was given.
    this.sourceIndexLoaded = sourceIndexLoaded ?? chunks.length > 0;

    // Chunks are handed out by reference too, so they are frozen individually. The
    // index arrays built below are ours and stay sortable.
    for (const chunk of chunks) deepFreeze(chunk);
    this.chunksById = new Map(chunks.map((c) => [c.chunkId, c]));
    this.evidenceById = new Map(document.evidence.map((e) => [e.id, e]));
    this.symbolsById = new Map(document.code.symbols.map((s) => [s.id, s]));
    this.filesByPath = new Map(document.inventory.files.map((f) => [f.path, f]));

    this.chunksByPath = new Map();
    for (const chunk of chunks) {
      if (!this.chunksByPath.has(chunk.path)) this.chunksByPath.set(chunk.path, []);
      this.chunksByPath.get(chunk.path).push(chunk);
    }
    for (const list of this.chunksByPath.values()) list.sort((a, b) => a.lineStart - b.lineStart);

    // Every addressable record in this run, so an id lookup can be checked for
    // membership before anything is returned.
    this.recordsById = new Map();
    for (const [kind, collection] of Object.entries(document.detections)) {
      for (const record of collection) this.recordsById.set(record.id, { kind, record });
    }
    for (const symbol of document.code.symbols) {
      this.recordsById.set(symbol.id, { kind: "code.symbols", record: symbol });
    }
    for (const call of document.code.calls) {
      this.recordsById.set(call.id, { kind: "code.calls", record: call });
    }

    // Adjacency for neighbour queries: call edges plus declaration containment.
    this.neighbours = new Map();
    const link = (a, b, edgeKind) => {
      if (!this.neighbours.has(a)) this.neighbours.set(a, []);
      this.neighbours.get(a).push({ id: b, edgeKind });
    };
    for (const call of document.code.calls) {
      link(call.callerSymbolId, call.calleeSymbolId, "calls");
      link(call.calleeSymbolId, call.callerSymbolId, "called-by");
    }
    for (const symbol of document.code.symbols) {
      if (symbol.parentSymbolId) {
        link(symbol.id, symbol.parentSymbolId, "declared-in");
        link(symbol.parentSymbolId, symbol.id, "declares");
      }
    }
  }

  /**
   * @param {string} dir
   * @param {{includeSourceIndex?: boolean}} [options]
   *   `includeSourceIndex: false` builds a store with no cached source at all. This is
   *   how the static-only exposure policy is enforced: rather than filtering content out
   *   of responses - which leaves the content in memory, one bug away from a caller -
   *   the private index is simply never read. A server cannot serve what it does not
   *   hold.
   */
  static fromDirectory(dir, { includeSourceIndex = true } = {}) {
    const staticPath = path.join(dir, "STATIC_ANALYSIS.json");
    const indexPath = path.join(dir, "SOURCE_INDEX.jsonl");
    const document = JSON.parse(fs.readFileSync(staticPath, "utf8"));
    const chunks = includeSourceIndex && fs.existsSync(indexPath)
      ? fs.readFileSync(indexPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return new RunStore(document, chunks, {
      loadedFrom: dir,
      sourceIndexLoaded: includeSourceIndex && fs.existsSync(indexPath),
    });
  }

  /** Chunks covering a line range, used to serve evidence from cache alone. */
  chunksCovering(relPath, lineStart, lineEnd) {
    return (this.chunksByPath.get(relPath) ?? []).filter(
      (c) => c.lineEnd >= lineStart && c.lineStart <= lineEnd,
    );
  }

  summary() {
    const d = this.document;
    return {
      runId: this.runId,
      repository: d.repository.name,
      revision: d.repository.revision,
      treeFingerprint: d.repository.treeFingerprint,
      files: d.inventory.files.length,
      symbols: d.code.symbols.length,
      calls: d.code.calls.length,
      evidence: d.evidence.length,
      chunks: this.chunksById.size,
      sourceExposure: this.sourceIndexLoaded ? "cached-source" : "static-only",
      scannedAt: d.scanner.completedAt,
    };
  }
}
