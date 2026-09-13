/**
 * Claude Code CLI adapter.
 *
 * Drives `claude -p` with the ContextKit MCP server attached and every filesystem tool
 * withheld. The shape mirrors the existing shell helper in bin/contextkit, with one
 * deliberate difference: that helper passes `--add-dir` and `--tools Read,Glob,Grep` so
 * the model reads the repository itself. Here it cannot - facts arrive only through
 * `mcp__contextkit__*`, which is the boundary the whole static/semantic split depends on.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ProviderError, analysisResult, createIsolatedWorkspace, extractJson, mcpServerDescriptor,
  readAccessLog, run,
} from "./provider.mjs";
import { toClaudeSchema } from "../../../scripts/claude-schema.mjs";

const TOOL_PREFIX = "mcp__contextkit__";

/** Tools withheld explicitly, so a permission-mode change cannot quietly re-enable them. */
const WITHHELD = [
  "Read", "Glob", "Grep", "Bash", "Edit", "Write", "NotebookEdit",
  "WebFetch", "WebSearch", "Task", "TodoWrite",
];

export class ClaudeCliProvider {
  constructor({ model = null, maxTurns = 30, timeoutMs = 300_000, binary = "claude" } = {}) {
    this.name = "claude";
    this.model = model;
    this.maxTurns = maxTurns;
    this.timeoutMs = timeoutMs;
    this.binary = binary;
  }

  async available() {
    const probe = await run(this.binary, ["--version"], { timeoutMs: 15_000 });
    return probe.ok ? probe.stdout.trim() : null;
  }

  /**
   * @param {{sliceId: string, prompt: string, systemPrompt?: string, schema?: object|null,
   *          runDir: string, toolNames: string[], workDir?: string}} request
   */
  async analyzeSlice(request) {
    const {
      sliceId, prompt, systemPrompt = null, schema = null, runDir, toolNames,
      workDir = null, sourceExposure = "static-only",
    } = request;

    const workspace = workDir ?? createIsolatedWorkspace(`claude-${sliceId}`);
    const mcpLog = path.join(workspace, "mcp-access.json");
    const descriptor = mcpServerDescriptor(runDir, { logPath: mcpLog, sourceExposure });
    const configPath = path.join(workspace, "mcp-config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        [descriptor.name]: { command: descriptor.command, args: descriptor.args },
      },
    }, null, 2));

    const args = [
      "-p",
      "--strict-mcp-config",
      "--mcp-config", configPath,
      "--allowedTools", toolNames.map((t) => `${TOOL_PREFIX}${t}`).join(","),
      "--disallowedTools", WITHHELD.join(","),
      "--max-turns", String(this.maxTurns),
      "--output-format", "json",
    ];
    if (this.model) args.push("--model", this.model);
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    // Claude compiles the schema with a strict validator that rejects $defs alongside a
    // draft-07 $schema. Normalizing is provider-specific, so it happens here rather than
    // in the schema, which stays portable.
    if (schema) args.push("--json-schema", JSON.stringify(toClaudeSchema(schema)));

    const startedAt = Date.now();
    const outcome = await run(this.binary, [...args, prompt], {
      cwd: workspace, timeoutMs: this.timeoutMs,
    });
    const durationMs = Date.now() - startedAt;

    const transcriptPath = path.join(workspace, "transcript.json");
    fs.writeFileSync(transcriptPath, JSON.stringify({
      args, stdout: outcome.stdout, stderr: outcome.stderr, status: outcome.status,
    }, null, 2));

    if (!outcome.ok) {
      throw new ProviderError(
        outcome.timedOut ? `claude timed out after ${this.timeoutMs}ms` : "claude exited non-zero",
        { provider: this.name, stage: "invoke", stderr: outcome.stderr, code: outcome.status });
    }

    // --output-format json wraps the answer in an envelope; the text we want is `result`.
    const envelope = extractJson(outcome.stdout);
    const text = envelope && typeof envelope.result === "string" ? envelope.result : outcome.stdout;

    return analysisResult({
      provider: this.name,
      model: envelope?.model ?? this.model,
      sliceId,
      result: extractJson(text),
      raw: text,
      usage: envelope?.usage ?? null,
      durationMs,
      transcriptPath,
      mcpReport: readAccessLog(mcpLog),
    });
  }
}
