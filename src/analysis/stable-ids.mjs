/**
 * Deterministic identifier helpers.
 *
 * Every id in the static artifact is a pure function of normalized content, so a
 * second scan of an unchanged repository produces byte-identical ids. Nothing here
 * may depend on array order, wall-clock time, or filesystem iteration order.
 */
import { createHash } from "node:crypto";

/** Identifier grammar shared with the published facts contract. */
export const ID_PATTERN = /^[a-z][a-z0-9._:-]*$/;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function shortHash(value, length = 10) {
  return sha256(value).slice(0, length);
}

/** Lower-case a fragment into the published id grammar without collapsing meaning. */
export function slug(value, max = 60) {
  const cleaned = String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .toLowerCase();
  const trimmed = cleaned.slice(0, max).replace(/[-._]+$/g, "");
  return trimmed || "x";
}

function compose(prefix, ...parts) {
  const id = [prefix, ...parts.filter((p) => p !== null && p !== undefined && p !== "")].join(".");
  if (!ID_PATTERN.test(id)) {
    throw new Error(`generated id is not a valid identifier: ${id}`);
  }
  return id;
}

/**
 * Evidence ids follow the shape recommended by the analysis plan:
 *   ev.<path-slug>.<symbol-or-region-slug>.<excerpt-hash-prefix>
 * The excerpt hash keeps the id stable while the supporting content is unchanged
 * and forces a new id the moment the cited text changes.
 */
export function evidenceId(path, region, normalizedExcerpt) {
  return compose("ev", slug(path, 70), slug(region || "region", 40), shortHash(normalizedExcerpt, 8));
}

export function symbolId(path, qualifiedName) {
  return compose("sym", slug(path, 70), slug(qualifiedName, 60));
}

export function callId(callerId, calleeId, index) {
  return compose("call", shortHash(`${callerId}>${calleeId}#${index}`, 12));
}

export function chunkId(content) {
  return compose("chunk", shortHash(content, 16));
}

export function detectionId(kind, ...parts) {
  return compose(kind, ...parts.map((p) => slug(p, 50)));
}

/** Stable ordering so serialized arrays never depend on traversal order. */
export function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function byPathThenLine(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return (a.lineStart ?? 0) - (b.lineStart ?? 0);
}
