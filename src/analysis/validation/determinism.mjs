/**
 * Determinism normalization.
 *
 * Phase 1's exit criterion is that repeated scans of the same snapshot produce identical
 * normalized output. "Normalized" needs a definition that lives in code rather than in
 * whoever is comparing two files today, because the useful question is not "are these
 * byte-identical" - they never are, a scan measures its own duration - but "is anything
 * other than the measurement of time different".
 *
 * So this module names the volatile fields exhaustively and small. Everything not named
 * here is expected to be reproducible, and `diffDocuments` reports what moved, which is
 * what turns a determinism regression into a readable failure instead of a hash
 * mismatch.
 */

/**
 * Fields that legitimately differ between two runs of the same snapshot. Deliberately
 * short: a field earns a place here only if it measures the run rather than the
 * repository. Anything added carelessly makes the determinism test weaker without
 * making it fail, so additions want a reason in the commit.
 */
export const VOLATILE_FIELDS = Object.freeze([
  "scanner.startedAt",
  "scanner.completedAt",
  "scanner.durationMs",
  "scanner.extractors[].durationMs",
]);

/** Deep clone with the volatile fields removed. */
export function normalizeDocument(document) {
  const clone = JSON.parse(JSON.stringify(document));
  if (clone.scanner) {
    delete clone.scanner.startedAt;
    delete clone.scanner.completedAt;
    delete clone.scanner.durationMs;
    for (const extractor of clone.scanner.extractors ?? []) delete extractor.durationMs;
  }
  return clone;
}

/**
 * Every path at which two documents differ, as dotted paths with array indices.
 *
 * Reports the paths rather than the values: a difference in a 500-file inventory is
 * useless as a diff of two 500KB blobs, and the path alone says which extractor to look
 * at.
 */
export function diffDocuments(a, b, pathHint = "", differences = []) {
  if (a === b) return differences;

  const typeOf = (v) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
  if (typeOf(a) !== typeOf(b)) {
    differences.push(pathHint || "(root)");
    return differences;
  }

  if (Array.isArray(a)) {
    if (a.length !== b.length) differences.push(`${pathHint}.length`);
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      diffDocuments(a[i], b[i], `${pathHint}[${i}]`, differences);
    }
    return differences;
  }

  if (a && typeof a === "object") {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const next = pathHint ? `${pathHint}.${key}` : key;
      if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) differences.push(next);
      else diffDocuments(a[key], b[key], next, differences);
    }
    return differences;
  }

  if (a !== b) differences.push(pathHint || "(root)");
  return differences;
}

/** Collapse `scanner.extractors[3].durationMs` to its VOLATILE_FIELDS shape. */
export function generalizePath(path) {
  return path.replace(/\[\d+\]/g, "[]");
}

/**
 * Compare two runs of the same snapshot.
 *
 * `deterministic` answers the exit criterion. `volatileDifferences` and
 * `unexpectedDifferences` are kept apart so a new nondeterministic field shows up as
 * itself rather than disappearing into an ever-growing ignore list.
 */
export function compareRuns(first, second) {
  const raw = diffDocuments(first, second).map(generalizePath);
  const volatile = new Set(VOLATILE_FIELDS);
  const unexpectedDifferences = [...new Set(raw.filter((p) => !volatile.has(p)))].sort();
  const volatileDifferences = [...new Set(raw.filter((p) => volatile.has(p)))].sort();
  return {
    deterministic: unexpectedDifferences.length === 0,
    unexpectedDifferences,
    volatileDifferences,
  };
}
