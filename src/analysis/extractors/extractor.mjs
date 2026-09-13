/**
 * Extractor provenance.
 *
 * Every extractor reports what it considered, what it managed to parse, what it
 * emitted, and whether its results are exact or heuristic. This is what makes a
 * scanner upgrade diagnosable: when a repository yields different facts, the
 * provenance block says which extractor changed its behaviour.
 */
export class ExtractorRun {
  constructor({ name, version, exactness = "exact", supports = [] }) {
    this.name = name;
    this.version = version;
    this.exactness = exactness;     // "exact" | "heuristic" | "mixed"
    this.supports = supports;
    this.filesConsidered = 0;
    this.filesParsed = 0;
    this.recordsEmitted = 0;
    this.parseFailures = [];
    this.warnings = [];
    this.available = true;
    this.unavailableReason = null;
    this.startedAt = Date.now();
    this.durationMs = 0;
  }

  consider(n = 1) { this.filesConsidered += n; }
  parsed(n = 1) { this.filesParsed += n; }
  emitted(n = 1) { this.recordsEmitted += n; }

  fail(path, message) {
    this.parseFailures.push({ path, message: String(message).slice(0, 300) });
  }

  warn(message) {
    this.warnings.push(String(message).slice(0, 300));
  }

  unavailable(reason) {
    this.available = false;
    this.unavailableReason = reason;
  }

  finish() {
    this.durationMs = Date.now() - this.startedAt;
    return this.toJSON();
  }

  toJSON() {
    return {
      name: this.name,
      version: this.version,
      exactness: this.exactness,
      supports: this.supports,
      available: this.available,
      unavailableReason: this.unavailableReason,
      filesConsidered: this.filesConsidered,
      filesParsed: this.filesParsed,
      recordsEmitted: this.recordsEmitted,
      parseFailureCount: this.parseFailures.length,
      parseFailures: this.parseFailures.slice(0, 20),
      warnings: this.warnings.slice(0, 20),
      durationMs: this.durationMs,
    };
  }
}
