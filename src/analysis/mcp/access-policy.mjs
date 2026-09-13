/**
 * MCP access policy.
 *
 * Every rule here exists because the provider is untrusted with respect to the host:
 * it may only reach one run, only by record id, never by host path, never past a
 * response budget, and never into content marked sensitive.
 *
 * A denial is a structured result, not an exception, so the caller can log it and the
 * provider can be told what it may do instead.
 */
export const LIMITS = {
  maxRecordsPerCall: 100,
  maxChunksPerCall: 25,
  maxResponseBytes: 256 * 1024,
  maxNeighborDepth: 3,
  maxNeighborResults: 200,
  maxSearchResults: 50,
  maxEvidenceLines: 400,
};

export class AccessDenied extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = "AccessDenied";
    this.code = code;
    this.detail = detail;
  }
}

/** Anything that looks like a host path or traversal is refused outright. */
export function assertNoHostPath(value, field = "value") {
  if (typeof value !== "string") return;
  const looksAbsolute = value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value);
  const hasTraversal = value.split(/[\\/]/).includes("..");
  const isFileUrl = /^file:\/\//i.test(value);
  if (looksAbsolute || hasTraversal || isFileUrl) {
    throw new AccessDenied(
      "host-path-rejected",
      `${field} must reference a record in this run, not a host path`,
      { field, value: value.slice(0, 120) },
    );
  }
}

/** A provider session is bound to exactly one run for its whole lifetime. */
export function assertRunScope(sessionRunId, requestedRunId) {
  if (requestedRunId && requestedRunId !== sessionRunId) {
    throw new AccessDenied(
      "cross-run-rejected",
      "this session may only access its own run",
      { sessionRunId, requestedRunId },
    );
  }
}

export function assertKnownRecord(store, id, field = "id") {
  assertNoHostPath(id, field);
  if (!store.recordsById.has(id) && !store.evidenceById.has(id) && !store.chunksById.has(id)) {
    throw new AccessDenied("unknown-record", `${field} does not name a record in this run`, { id });
  }
}

export function clampLimit(requested, max, fallback = max) {
  const value = Number.isInteger(requested) ? requested : fallback;
  return Math.max(1, Math.min(value, max));
}

/**
 * Truncate a response that would otherwise return an unreasonable share of the cache.
 * The result says it was truncated rather than silently returning less.
 */
export function applyResponseBudget(items, serialize = JSON.stringify) {
  const kept = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(serialize(item));
    if (bytes + size > LIMITS.maxResponseBytes) {
      return { items: kept, truncated: true, omitted: items.length - kept.length, bytes };
    }
    kept.push(item);
    bytes += size;
  }
  return { items: kept, truncated: false, omitted: 0, bytes };
}

/**
 * A sensitive chunk keeps its metadata and hash and loses its text. The provider can
 * learn that a definition exists at a location without receiving the value.
 */
export function redactChunk(chunk) {
  if (!chunk.sensitive) return chunk;
  // Frozen like the cached originals, so the provider never receives a mutable record
  // on one path and an immutable one on another.
  return Object.freeze({
    ...chunk,
    content: null,
    redacted: true,
    redactionReason: "chunk matched the sensitive-content policy",
  });
}

export function redactEvidence(record) {
  if (!record.sensitive) return record;
  return Object.freeze({ ...record, excerpt: null, redacted: true });
}
