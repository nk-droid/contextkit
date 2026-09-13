/**
 * Scan policy: exclusions, limits, and file classification.
 *
 * Classification runs in the fixed order given by the analysis plan and every rule
 * carries a stable id, so any classification in the output can be explained by
 * naming the rule that produced it.
 */
import path from "node:path";

export const POLICY_VERSION = "1.0.0";

/** Directories never worth inspecting; matched on any path segment. */
export const EXCLUDED_DIRECTORIES = [
  { pattern: "node_modules", ruleId: "exclude.node-modules", reason: "Installed third-party packages." },
  { pattern: ".git", ruleId: "exclude.git", reason: "Version control internals." },
  { pattern: ".venv", ruleId: "exclude.venv", reason: "Python virtual environment." },
  { pattern: "venv", ruleId: "exclude.venv-plain", reason: "Python virtual environment." },
  { pattern: "__pycache__", ruleId: "exclude.pycache", reason: "Python bytecode cache." },
  { pattern: ".next", ruleId: "exclude.next", reason: "Next build output." },
  { pattern: ".wrangler", ruleId: "exclude.wrangler", reason: "Cloudflare local state." },
  { pattern: "dist", ruleId: "exclude.dist", reason: "Build output." },
  { pattern: "build", ruleId: "exclude.build", reason: "Build output." },
  { pattern: ".ruff_cache", ruleId: "exclude.ruff-cache", reason: "Linter cache." },
  { pattern: ".pytest_cache", ruleId: "exclude.pytest-cache", reason: "Test runner cache." },
];

/** Defaults chosen so a scan of a large repository stays bounded and reproducible. */
export const DEFAULT_LIMITS = {
  maxFileBytesForHash: 8 * 1024 * 1024,
  maxFileBytesForParse: 1.5 * 1024 * 1024,
  maxChunkLines: 160,
  maxExcerptChars: 500,
  maxRetainedSymbols: 400,
};

const LANGUAGE_BY_EXTENSION = new Map(Object.entries({
  ".ts": "TypeScript", ".tsx": "TypeScript/React", ".mts": "TypeScript", ".cts": "TypeScript",
  ".js": "JavaScript", ".jsx": "JavaScript/React", ".mjs": "JavaScript", ".cjs": "JavaScript",
  ".py": "Python", ".pyi": "Python",
  ".rs": "Rust", ".go": "Go", ".rb": "Ruby", ".java": "Java", ".kt": "Kotlin",
  ".cs": "C#", ".php": "PHP", ".swift": "Swift", ".scala": "Scala",
  ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell",
  ".sql": "SQL", ".css": "CSS", ".scss": "SCSS", ".html": "HTML",
  ".json": "JSON", ".jsonc": "JSON", ".yaml": "YAML", ".yml": "YAML",
  ".toml": "TOML", ".ini": "INI", ".cfg": "INI", ".env": "Dotenv",
  ".md": "Markdown", ".mdx": "Markdown", ".txt": "Plain text",
  ".svg": "SVG", ".png": "PNG", ".jpg": "JPEG", ".jpeg": "JPEG", ".gif": "GIF",
  ".webp": "WebP", ".ico": "Icon", ".pdf": "PDF", ".mp4": "MP4", ".mov": "MOV",
  ".woff": "Font", ".woff2": "Font", ".ttf": "Font",
  ".lock": "Lockfile",
}));

const LANGUAGE_BY_FILENAME = new Map(Object.entries({
  "Makefile": "Make", "makefile": "Make", "GNUmakefile": "Make",
  "Dockerfile": "Dockerfile", "Containerfile": "Dockerfile",
  ".gitignore": "Ignore file", ".dockerignore": "Ignore file", ".npmignore": "Ignore file",
  ".env.example": "Dotenv", ".env.sample": "Dotenv",
  "go.mod": "Go module", "go.sum": "Go checksum",
  "Gemfile": "Ruby", "Rakefile": "Ruby",
}));

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".mp4", ".mov",
  ".woff", ".woff2", ".ttf", ".eot", ".zip", ".gz", ".tar", ".bz2", ".7z",
  ".class", ".jar", ".so", ".dylib", ".dll", ".exe", ".wasm", ".bin",
]);

const GENERATED_FILENAMES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Cargo.lock",
  "uv.lock", "Gemfile.lock", "composer.lock", "go.sum",
]);

const SENSITIVE_FILENAME = /(^|[./])(\.env(\.[a-z]+)?|secrets?|credentials?|id_rsa|.*\.pem|.*\.key|.*\.p12)$/i;
const SENSITIVE_CONTENT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][^'"]{8,}['"]/i,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
];

/** Documentation, config, source, test, asset - the kind used by the published inventory. */
export function classifyKind(relPath) {
  const base = path.basename(relPath);
  const ext = path.extname(relPath).toLowerCase();
  const lower = relPath.toLowerCase();

  if (/(^|\/)(tests?|__tests__|spec)\//.test(lower) || /(^|[._-])(test|spec)\.[a-z]+$/.test(base) ||
      /^test_.*\.py$/.test(base)) {
    return { kind: "test", ruleId: "kind.test-path" };
  }
  if (BINARY_EXTENSIONS.has(ext)) return { kind: "binary-asset", ruleId: "kind.binary-extension" };
  if (ext === ".md" || ext === ".mdx" || lower.startsWith("docs/")) {
    return { kind: "documentation", ruleId: "kind.documentation" };
  }
  if (LANGUAGE_BY_FILENAME.get(base) === "Dockerfile" || base.toLowerCase().includes("dockerfile")) {
    return { kind: "configuration", ruleId: "kind.dockerfile" };
  }
  if ([".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".env"].includes(ext) ||
      base === "Makefile" || base.startsWith(".env")) {
    return { kind: "configuration", ruleId: "kind.config-extension" };
  }
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".rb",
       ".java", ".kt", ".cs", ".php", ".swift", ".sh", ".sql", ".css", ".scss"].includes(ext)) {
    return { kind: "source", ruleId: "kind.source-extension" };
  }
  if (ext === ".txt") return { kind: "text-asset", ruleId: "kind.text-asset" };
  return { kind: "other", ruleId: "kind.fallback" };
}

export function classifyLanguage(relPath) {
  const base = path.basename(relPath);
  if (LANGUAGE_BY_FILENAME.has(base)) {
    return { language: LANGUAGE_BY_FILENAME.get(base), ruleId: "lang.filename" };
  }
  const ext = path.extname(relPath).toLowerCase();
  if (LANGUAGE_BY_EXTENSION.has(ext)) {
    return { language: LANGUAGE_BY_EXTENSION.get(ext), ruleId: "lang.extension" };
  }
  return { language: null, ruleId: "lang.unknown" };
}

export function isGenerated(relPath) {
  const base = path.basename(relPath);
  if (GENERATED_FILENAMES.has(base)) return { generated: true, ruleId: "generated.lockfile" };
  if (/\.(min|bundle)\.(js|css)$/.test(base)) return { generated: true, ruleId: "generated.minified" };
  if (/(^|\/)(dist|build|out|__generated__|\.next)\//.test(relPath)) {
    return { generated: true, ruleId: "generated.output-directory" };
  }
  return { generated: false, ruleId: "generated.none" };
}

export function isVendored(relPath) {
  if (/(^|\/)(vendor|third_party|node_modules)\//.test(relPath)) {
    return { vendored: true, ruleId: "vendored.directory" };
  }
  return { vendored: false, ruleId: "vendored.none" };
}

export function isExcludedPath(relPath) {
  const segments = relPath.split("/");
  for (const rule of EXCLUDED_DIRECTORIES) {
    if (segments.includes(rule.pattern)) return rule;
  }
  return null;
}

/**
 * Sensitivity is decided before any content reaches a model. A sensitive chunk keeps
 * its metadata and hash so the model can learn a definition exists without receiving
 * the value.
 */
export function classifySensitivity(relPath, content) {
  if (SENSITIVE_FILENAME.test(path.basename(relPath)) || SENSITIVE_FILENAME.test(relPath)) {
    return { sensitive: true, ruleId: "sensitive.filename" };
  }
  if (typeof content === "string") {
    for (const [i, pattern] of SENSITIVE_CONTENT.entries()) {
      if (pattern.test(content)) return { sensitive: true, ruleId: `sensitive.content-${i}` };
    }
  }
  return { sensitive: false, ruleId: "sensitive.none" };
}

/** Reject anything that would escape the repository root. */
export function isSafeRelativePath(relPath) {
  if (!relPath || relPath.length > 1024) return false;
  if (path.isAbsolute(relPath) || /^[A-Za-z]:[\\/]/.test(relPath)) return false;
  return !relPath.split(/[\\/]/).includes("..");
}

export function looksBinary(buffer) {
  const window = buffer.subarray(0, 4096);
  return window.includes(0);
}
