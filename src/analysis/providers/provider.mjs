/**
 * Provider-neutral analysis boundary (plan §13.1).
 *
 * A provider receives a slice definition, an output schema, and a descriptor for the
 * ContextKit MCP server, and returns a structured result. Everything provider-specific -
 * flags, authentication, streaming, response envelopes - belongs inside an adapter, so
 * nothing about Codex or Claude reaches the facts.
 *
 * The important shared behaviour lives here rather than in either adapter: the working
 * directory a provider is launched in.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export class ProviderError extends Error {
  constructor(message, { provider, stage, stderr = "", code = null } = {}) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.stage = stage;
    this.stderr = String(stderr).slice(-4000);
    this.code = code;
  }
}

/**
 * An empty directory to launch the provider in.
 *
 * This is the load-bearing part of the isolation, and it is deliberately cruder than a
 * permission flag. Tool allowlists express intent and can be got around by a model that
 * finds another way to read a file; an empty working directory means there is no
 * repository on disk to read in the first place. Whatever the provider does, the only
 * route to repository facts is the MCP server - which makes "the scanner is the only
 * stage that reads the target repository" testable rather than merely intended.
 */
export function createIsolatedWorkspace(label = "run") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `contextkit-${label}-`));
  fs.writeFileSync(path.join(dir, "README.md"), [
    "# Analysis workspace",
    "",
    "Intentionally empty. The repository under analysis is not on this filesystem.",
    "Reach its facts through the `contextkit` MCP server.",
    "",
  ].join("\n"));
  return dir;
}

/** The stdio MCP server descriptor both adapters configure their client with. */
export function mcpServerDescriptor(runDir, { logPath = null } = {}) {
  const entry = path.resolve(
    path.dirname(new URL(import.meta.url).pathname), "../../../bin/contextkit-mcp-stdio");
  const args = [entry, path.resolve(runDir)];
  if (logPath) args.push("--log", path.resolve(logPath));
  return { name: "contextkit", command: process.execPath, args };
}

/**
 * Run a command to completion, capturing output.
 *
 * Timeouts kill the process group rather than the leader: a provider CLI spawns the MCP
 * server as a child, and killing only the parent leaves that child holding the pipe.
 */
export function run(command, args, {
  cwd, input = null, timeoutMs = 300_000, env = process.env,
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, timeoutMs);

    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, status: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut, spawnError: error });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ ok: status === 0 && !timedOut, status, stdout, stderr, timedOut });
    });

    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Pull the first JSON object or array out of a model's text response.
 *
 * Even with a response schema, providers wrap output in prose or fences often enough
 * that parsing has to tolerate it. Brace matching rather than a regex, so a JSON string
 * containing a brace does not truncate the object.
 */
export function extractJson(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch { /* fall through to scanning */ }

  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch { /* fall through */ }
  }

  for (let i = 0; i < trimmed.length; i += 1) {
    const open = trimmed[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < trimmed.length; j += 1) {
      const ch = trimmed[j];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(i, j + 1));
          } catch { break; }
        }
      }
    }
  }
  return null;
}

/**
 * Read what the provider touched.
 *
 * The `.jsonl` is authoritative because it is appended per call and therefore survives
 * the provider killing the server; the `.json` summary only exists when the server got
 * to shut down cleanly. Preferring the summary would mean reporting "no calls" for a
 * session that made plenty.
 */
export function readAccessLog(logPath) {
  const lines = `${logPath}l`;
  if (fs.existsSync(lines)) {
    const entries = fs.readFileSync(lines, "utf8").split("\n").filter(Boolean)
      .map((line) => JSON.parse(line));
    const denied = entries.filter((e) => e.outcome === "denied");
    return {
      calls: entries.length,
      denied: denied.length,
      deniedByCode: denied.reduce((acc, e) => {
        const code = (e.detail ?? "").split(":")[0];
        acc[code] = (acc[code] ?? 0) + 1;
        return acc;
      }, {}),
      accessLog: entries,
      source: lines,
    };
  }
  if (fs.existsSync(logPath)) return JSON.parse(fs.readFileSync(logPath, "utf8"));
  return null;
}

/**
 * The shape every adapter returns, so callers never branch on which provider ran.
 */
export function analysisResult({
  provider, model, sliceId, result, raw, usage = null, transcriptPath = null,
  durationMs, mcpReport = null,
}) {
  return {
    provider, model, sliceId,
    result,
    ok: result !== null,
    usage,
    durationMs,
    transcriptPath,
    mcpReport,
    rawLength: typeof raw === "string" ? raw.length : null,
  };
}
