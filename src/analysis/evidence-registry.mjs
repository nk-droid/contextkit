/**
 * Canonical evidence registry.
 *
 * Only deterministic code may create evidence. Every record is validated against the
 * file inventory before it is accepted, so an evidence path that does not exist, or a
 * line range beyond the end of its file, fails at construction rather than surviving
 * into the published artifact.
 *
 * Detail text must state what the cited region *declares*, not what it means. "declares
 * the GET handler" is a scanner observation; "securely fetches repositories" is a
 * semantic conclusion and belongs to the analysis stage.
 */
import { DEFAULT_LIMITS, classifySensitivity } from "./policy.mjs";
import { evidenceId, sha256 } from "./stable-ids.mjs";

/** Normalizing before hashing keeps ids stable across trailing-whitespace churn. */
function normalizeExcerpt(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

export class EvidenceRegistry {
  /** @param {Map<string, {lineCount:number|null, sha256:string|null}>} inventoryByPath */
  constructor(inventoryByPath, limits = DEFAULT_LIMITS) {
    this.inventory = inventoryByPath;
    this.limits = limits;
    this.records = new Map();
    this.rejected = [];
  }

  /**
   * @returns {string|null} the evidence id, or null when the citation could not be
   * validated. Callers must treat null as "no evidence available" rather than
   * fabricating one.
   */
  add({ path: relPath, lineStart, lineEnd, symbol = null, detail, sourceText, region = null }) {
    const file = this.inventory.get(relPath);
    if (!file) {
      this.rejected.push({ path: relPath, reason: "path is not in the file inventory" });
      return null;
    }
    if (!Number.isInteger(lineStart) || lineStart < 1) {
      this.rejected.push({ path: relPath, reason: `invalid lineStart ${lineStart}` });
      return null;
    }
    let end = Number.isInteger(lineEnd) ? lineEnd : lineStart;
    if (end < lineStart) {
      this.rejected.push({ path: relPath, reason: "lineEnd precedes lineStart" });
      return null;
    }
    if (file.lineCount != null) {
      if (lineStart > file.lineCount) {
        this.rejected.push({ path: relPath, reason: `lineStart ${lineStart} exceeds ${file.lineCount} lines` });
        return null;
      }
      end = Math.min(end, file.lineCount);
    }

    const raw = typeof sourceText === "string" ? sourceText : "";
    const excerptFull = normalizeExcerpt(
      raw.split("\n").slice(lineStart - 1, end).filter((l) => l.trim() !== "").join("\n"),
    );
    const excerpt = excerptFull.slice(0, this.limits.maxExcerptChars);
    const sensitivity = classifySensitivity(relPath, excerptFull);

    const id = evidenceId(relPath, region ?? symbol ?? `l${lineStart}`, excerptFull || `${relPath}:${lineStart}`);
    if (this.records.has(id)) return id;

    this.records.set(id, {
      id,
      path: relPath,
      sourceKind: "file",
      lineStart,
      lineEnd: end,
      symbol,
      detail,
      // A sensitive region keeps its location and hash but never its text.
      excerpt: sensitivity.sensitive ? null : excerpt,
      excerptSha256: excerptFull ? sha256(excerptFull) : null,
      fileSha256: file.sha256 ?? null,
      sensitive: sensitivity.sensitive,
      sensitiveRuleId: sensitivity.sensitive ? sensitivity.ruleId : null,
      // Only the verification stage may move this off not-checked.
      verificationStatus: "not-checked",
    });
    return id;
  }

  get(id) {
    return this.records.get(id) ?? null;
  }

  all() {
    return [...this.records.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  get size() {
    return this.records.size;
  }
}
