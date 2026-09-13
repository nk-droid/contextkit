/**
 * Code-position masking for text-scanning detectors.
 *
 * Several detectors find candidates by matching patterns against raw file text. Raw text
 * includes comments and string literals, so a detector will happily report a route from
 * a line of documentation, an entity from a test fixture's inline source, or - the case
 * that makes the problem obvious - a technology from the detector's own signal table.
 * Those are not marginal misses; they are facts the scanner will then defend as
 * measured, and no downstream check can recover from a confidently wrong observation.
 *
 * This module answers one question: is byte N of this file in code, or in a comment or
 * string? Detectors keep their patterns and simply ignore matches that begin outside
 * code. The *token* position is what matters - `app.get("/users")` has its call in code
 * and its path in a string, which is exactly right and stays detected.
 *
 * The lexer is approximate by design. It tracks the constructs that actually cause the
 * false positives (line and block comments, the three JavaScript quote forms, Python
 * strings including triple-quotes) and takes the standard preceding-token heuristic for
 * regular-expression literals. It is not a parser and does not need to be: a detector
 * that was already `confidence: medium` does not become exact here, it stops reporting
 * documentation as implementation.
 */
import path from "node:path";

export const CODE = 1;
export const NOT_CODE = 0;

const C_LIKE = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".java", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".go", ".rs", ".swift", ".kt", ".scala",
]);
const HASH_COMMENT = new Set([".py", ".rb", ".sh", ".bash", ".zsh", ".yml", ".yaml", ".toml", ".mk"]);

/** Languages whose content is data rather than code: masking them would hide real facts. */
const UNMASKED = new Set([".json", ".jsonl", ".md", ".markdown", ".txt", ".csv", ".lock", ".sql"]);

export function supportsMasking(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (UNMASKED.has(ext)) return false;
  return C_LIKE.has(ext) || HASH_COMMENT.has(ext) || path.basename(relPath) === "Makefile";
}

/**
 * A byte-per-character mask: CODE where the character is executable text, NOT_CODE
 * inside a comment or a string literal.
 *
 * Returns null for file kinds where masking does not apply, so a caller can treat "no
 * mask" as "scan everything" without special-casing each language.
 */
export function buildCodeMask(text, relPath) {
  if (!supportsMasking(relPath)) return null;

  const ext = path.extname(relPath).toLowerCase();
  const cLike = C_LIKE.has(ext);
  const hashComments = HASH_COMMENT.has(ext) || path.basename(relPath) === "Makefile";
  const python = ext === ".py";

  const mask = new Uint8Array(text.length).fill(CODE);
  let i = 0;

  /** The token before a `/` decides whether it opens a regex or is division. */
  const regexCanFollow = (index) => {
    for (let j = index - 1; j >= 0; j -= 1) {
      const ch = text[j];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
      return "(,=:[!&|?{};+-*%~^<>".includes(ch);
    }
    return true;
  };

  const markRange = (from, to) => {
    for (let j = from; j < to && j < mask.length; j += 1) mask[j] = NOT_CODE;
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (hashComments && ch === "#") {
      const end = text.indexOf("\n", i);
      markRange(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
      continue;
    }

    if (cLike && ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      markRange(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
      continue;
    }

    if (cLike && ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      markRange(i, stop);
      i = stop;
      continue;
    }

    if (python && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const quote = text.slice(i, i + 3);
      const end = text.indexOf(quote, i + 3);
      const stop = end === -1 ? text.length : end + 3;
      markRange(i, stop);
      i = stop;
      continue;
    }

    if (ch === '"' || ch === "'" || (cLike && ch === "`")) {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === ch) { j += 1; break; }
        // A single- or double-quoted string does not span lines; bail so an apostrophe
        // in a comment cannot swallow the rest of the file.
        if (text[j] === "\n" && ch !== "`") break;
        j += 1;
      }
      markRange(i, j);
      i = j;
      continue;
    }

    if (cLike && ch === "/" && regexCanFollow(i)) {
      let j = i + 1;
      let closed = false;
      while (j < text.length && text[j] !== "\n") {
        if (text[j] === "\\") { j += 2; continue; }
        if (text[j] === "[") {
          while (j < text.length && text[j] !== "]" && text[j] !== "\n") {
            j += text[j] === "\\" ? 2 : 1;
          }
        }
        if (text[j] === "/") { j += 1; closed = true; break; }
        j += 1;
      }
      if (closed) {
        markRange(i, j);
        i = j;
        continue;
      }
    }

    i += 1;
  }

  unmaskModuleSpecifiers(text, mask);
  return mask;
}

/**
 * Module specifiers are strings syntactically and code semantically.
 *
 * `import { trace } from "@opentelemetry/api"` is the strongest adoption signal a file
 * can carry, and masking it as a string literal turns the comment fix into a worse bug -
 * trading false positives for false negatives on exactly the evidence that matters most.
 * So the specifier in an import, re-export, or require is marked back as code.
 *
 * The keyword's own position is checked first, so a commented-out import stays masked.
 */
function unmaskModuleSpecifiers(text, mask) {
  const forms = [
    /\b(?:import|export)\b[^;\n]*?\bfrom\s*(["'])([^"'\n]+)\1/g,
    /\bimport\s*(["'])([^"'\n]+)\1/g,
    /\brequire\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
    /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g,
  ];
  for (const pattern of forms) {
    for (const match of text.matchAll(pattern)) {
      if (mask[match.index] !== CODE) continue;
      const specifier = match[2];
      const start = match.index + match[0].lastIndexOf(specifier);
      for (let j = start; j < start + specifier.length && j < mask.length; j += 1) {
        mask[j] = CODE;
      }
    }
  }
}

/** True when the position holds executable text, or when the file is not masked at all. */
export function isCodePosition(mask, index) {
  if (!mask) return true;
  return index >= 0 && index < mask.length && mask[index] === CODE;
}

/**
 * Matches of `pattern` whose match begins in code.
 *
 * Detectors should use this in place of `text.matchAll(pattern)`; the only behavioural
 * difference is that matches starting inside a comment or string are skipped.
 */
export function* matchesInCode(text, pattern, mask) {
  const global = pattern.flags.includes("g") ? pattern : new RegExp(pattern.source, `${pattern.flags}g`);
  for (const match of text.matchAll(global)) {
    if (isCodePosition(mask, match.index)) yield match;
  }
}

/** The first match beginning in code, or null. */
export function firstMatchInCode(text, pattern, mask) {
  for (const match of matchesInCode(text, pattern, mask)) return match;
  return null;
}

/** 1-based line number for an index, for evidence records. */
export function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * Whether a file is authored by this project, for heuristic signal matching.
 *
 * A lockfile names every transitive dependency of every dependency, so matching
 * technology signals against one reports things the project never chose - ContextKit
 * "uses OpenTelemetry" because something four levels down depends on its API package.
 * Vendored code is somebody else's decision for the same reason.
 *
 * This applies to signal matching, not to extraction: a generated migration or client
 * is still a real fact about the repository, so callers should apply it per-rule rather
 * than skipping generated files wholesale.
 */
export function isAuthored(fileRecord) {
  return Boolean(fileRecord) && !fileRecord.generated && !fileRecord.vendored;
}
