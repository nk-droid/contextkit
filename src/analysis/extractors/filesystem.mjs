/**
 * Filesystem extractor: the complete file inventory.
 *
 * Inventories every considered file, even those whose contents are never parsed, and
 * records the rule id behind each classification so any label can be explained.
 * Directory counts are derived from this inventory rather than gathered separately,
 * which is what stops the two from drifting apart.
 */
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_LIMITS, POLICY_VERSION, classifyKind, classifyLanguage,
  isGenerated, isVendored, looksBinary,
} from "../policy.mjs";
import { sha256 } from "../stable-ids.mjs";
import { ExtractorRun } from "./extractor.mjs";

export function buildInventory(root, candidateFiles, limits = DEFAULT_LIMITS) {
  const run = new ExtractorRun({
    name: "filesystem",
    version: POLICY_VERSION,
    exactness: "exact",
    supports: ["inventory", "classification", "hashing"],
  });

  const files = [];
  const contents = new Map();   // relPath -> decoded text, for later extractors

  for (const candidate of candidateFiles) {
    run.consider();
    const abs = path.join(root, candidate.path);
    let buffer;
    try {
      buffer = fs.readFileSync(abs);
    } catch (error) {
      run.fail(candidate.path, error.message);
      continue;
    }

    const kind = classifyKind(candidate.path);
    const language = classifyLanguage(candidate.path);
    const generated = isGenerated(candidate.path);
    const vendored = isVendored(candidate.path);
    const binary = looksBinary(buffer);

    let lineCount = null;
    let text = null;
    if (!binary) {
      text = buffer.toString("utf8");
      lineCount = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      if (lineCount === 0 && text.length > 0) lineCount = 1;
      if (buffer.length <= limits.maxFileBytesForParse) contents.set(candidate.path, text);
    }

    const hashable = buffer.length <= limits.maxFileBytesForHash;
    let depth = "metadata-only";
    let reasonNotInspected = null;
    if (binary) {
      depth = "not-inspected";
      reasonNotInspected = "Binary content is not parsed.";
    } else if (buffer.length > limits.maxFileBytesForParse) {
      depth = "metadata-only";
      reasonNotInspected = `File exceeds the ${limits.maxFileBytesForParse}-byte parse limit.`;
    }

    files.push({
      path: candidate.path,
      kind: kind.kind,
      language: language.language,
      bytes: buffer.length,
      lineCount,
      sha256: hashable ? sha256(buffer) : null,
      tracked: true,
      executable: candidate.executable,
      binary,
      generated: generated.generated,
      vendored: vendored.vendored,
      ignored: false,
      inspectionDepth: depth,
      reasonNotInspected,
      classification: {
        kindRuleId: kind.ruleId,
        languageRuleId: language.ruleId,
        generatedRuleId: generated.ruleId,
        vendoredRuleId: vendored.ruleId,
      },
    });
    run.parsed();
    run.emitted();
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, contents, provenance: run.finish() };
}

/** Directory records derived from the inventory - never counted independently. */
export function deriveDirectories(files) {
  const direct = new Map();
  const total = new Map();
  const children = new Map();

  for (const file of files) {
    const segments = file.path.split("/");
    if (segments.length === 1) {
      direct.set(".", (direct.get(".") ?? 0) + 1);
      total.set(".", (total.get(".") ?? 0) + 1);
      continue;
    }
    const parent = segments.slice(0, -1).join("/");
    direct.set(parent, (direct.get(parent) ?? 0) + 1);
    for (let i = 1; i <= segments.length - 1; i += 1) {
      const dir = segments.slice(0, i).join("/");
      total.set(dir, (total.get(dir) ?? 0) + 1);
      if (i > 1) {
        const up = segments.slice(0, i - 1).join("/");
        if (!children.has(up)) children.set(up, new Set());
        children.get(up).add(dir);
      }
    }
  }

  return [...total.keys()].sort().map((dir) => ({
    path: dir,
    fileCount: total.get(dir) ?? 0,
    directFileCount: direct.get(dir) ?? 0,
    childDirectories: [...(children.get(dir) ?? [])].sort(),
  }));
}

export function summarizeLanguages(files) {
  const byLanguage = new Map();
  for (const file of files) {
    if (!file.language || file.binary) continue;
    const entry = byLanguage.get(file.language) ?? { language: file.language, fileCount: 0, estimatedLines: 0 };
    entry.fileCount += 1;
    entry.estimatedLines += file.lineCount ?? 0;
    byLanguage.set(file.language, entry);
  }
  return [...byLanguage.values()].sort((a, b) =>
    b.estimatedLines - a.estimatedLines || (a.language < b.language ? -1 : 1));
}

export function inventoryStatistics(files) {
  const text = files.filter((f) => !f.binary);
  return {
    discoveredFiles: files.length,
    consideredFiles: files.length,
    textFiles: text.length,
    binaryFiles: files.length - text.length,
    generatedFiles: files.filter((f) => f.generated).length,
    vendoredFiles: files.filter((f) => f.vendored).length,
    totalBytes: files.reduce((sum, f) => sum + f.bytes, 0),
    estimatedLines: text.reduce((sum, f) => sum + (f.lineCount ?? 0), 0),
  };
}
