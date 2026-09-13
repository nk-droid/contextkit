/**
 * Private content-addressed source index.
 *
 * SOURCE_INDEX.jsonl is an analysis input, never part of the published facts. It is
 * what makes "one repository lookup" concrete: the scanner reads the files once, and
 * every later stage queries this cache instead of reopening the working tree.
 *
 * Chunks prefer semantic boundaries - a declaration, a Markdown section, a Make
 * target - and fall back to line windows only where no parser established one.
 * A sensitive chunk keeps its metadata and hash but never its content, so a model can
 * learn that a definition exists without receiving the value.
 */
import path from "node:path";
import { DEFAULT_LIMITS, classifySensitivity } from "./policy.mjs";
import { chunkId, sha256 } from "./stable-ids.mjs";

/** Rough token estimate; only used to budget slices, never reported as exact. */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function windowChunks(lineCount, maxLines) {
  const windows = [];
  for (let start = 1; start <= lineCount; start += maxLines) {
    windows.push({ lineStart: start, lineEnd: Math.min(start + maxLines - 1, lineCount) });
  }
  return windows;
}

/** Markdown splits on headings, which are real authored boundaries. */
function markdownSections(text) {
  const lines = text.split("\n");
  const boundaries = [];
  lines.forEach((line, i) => {
    if (/^#{1,4}\s/.test(line)) boundaries.push(i + 1);
  });
  if (!boundaries.length) return null;
  if (boundaries[0] !== 1) boundaries.unshift(1);
  return boundaries.map((start, i) => ({
    lineStart: start,
    lineEnd: (boundaries[i + 1] ?? lines.length + 1) - 1,
  }));
}

/**
 * @param {{files: Array, contents: Map<string,string>, symbolsByPath: Map<string,Array>}} input
 */
export function buildSourceIndex({ files, contents, symbolsByPath }, limits = DEFAULT_LIMITS) {
  const chunks = [];
  let excludedSensitiveChunks = 0;

  for (const file of files) {
    const text = contents.get(file.path);
    if (text === undefined || file.binary) continue;
    const lineCount = file.lineCount ?? text.split("\n").length;
    if (!lineCount) continue;

    // Boundary selection, best available first.
    let regions = null;
    let boundary = "line-window";
    const symbols = symbolsByPath.get(file.path);
    if (symbols?.length) {
      regions = symbols
        .map((s) => ({ lineStart: s.lineStart, lineEnd: s.lineEnd, symbolIds: [s.id] }))
        .sort((a, b) => a.lineStart - b.lineStart);
      boundary = "declaration";
    } else if (path.extname(file.path) === ".md") {
      const sections = markdownSections(text);
      if (sections) { regions = sections; boundary = "markdown-section"; }
    }
    if (!regions) regions = windowChunks(lineCount, limits.maxChunkLines);

    const lines = text.split("\n");
    for (const region of regions) {
      const start = Math.max(1, region.lineStart);
      const end = Math.min(lineCount, region.lineEnd);
      if (end < start) continue;
      const content = lines.slice(start - 1, end).join("\n");
      if (!content.trim()) continue;
      const sensitivity = classifySensitivity(file.path, content);
      if (sensitivity.sensitive) excludedSensitiveChunks += 1;
      chunks.push({
        chunkId: chunkId(`${file.path}:${start}-${end}:${content}`),
        path: file.path,
        fileSha256: file.sha256,
        lineStart: start,
        lineEnd: end,
        language: file.language,
        symbolIds: region.symbolIds ?? [],
        roles: [file.kind],
        boundary,
        tokenEstimate: estimateTokens(content),
        sensitive: sensitivity.sensitive,
        sensitiveRuleId: sensitivity.sensitive ? sensitivity.ruleId : null,
        contentSha256: sha256(content),
        content: sensitivity.sensitive ? null : content,
      });
    }
  }

  chunks.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.lineStart - b.lineStart);

  const jsonl = chunks.map((c) => JSON.stringify(c)).join("\n") + (chunks.length ? "\n" : "");
  return {
    chunks,
    jsonl,
    summary: {
      artifact: "SOURCE_INDEX.jsonl",
      sha256: sha256(jsonl),
      chunkCount: chunks.length,
      includedBytes: chunks.reduce((sum, c) => sum + (c.content?.length ?? 0), 0),
      excludedSensitiveChunks,
    },
  };
}
