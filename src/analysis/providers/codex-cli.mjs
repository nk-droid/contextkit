/**
 * Codex CLI adapter.
 *
 * Same contract as the Claude adapter, different flags. Codex takes its prompt on stdin,
 * writes the final message to a file rather than stdout, and configures MCP servers
 * through dotted `-c` overrides whose values are parsed as TOML.
 *
 * Codex has no per-tool allowlist equivalent to --disallowedTools, so isolation rests
 * entirely on the empty working directory plus a read-only sandbox. That is the weaker
 * of the two setups and worth recording as a transport difference: with Claude the
 * repository is both absent and unreadable; with Codex it is merely absent.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ProviderError, analysisResult, createIsolatedWorkspace, extractJson, mcpServerDescriptor,
  readAccessLog, run,
} from "./provider.mjs";

/** TOML literal for a `-c key=value` override. */
const toml = (value) => JSON.stringify(value);

export class CodexCliProvider {
  constructor({ model = null, timeoutMs = 300_000, binary = "codex" } = {}) {
    this.name = "codex";
    this.model = model;
    this.timeoutMs = timeoutMs;
    this.binary = binary;
  }

  async available() {
    const probe = await run(this.binary, ["--version"], { timeoutMs: 15_000 });
    return probe.ok ? probe.stdout.trim() : null;
  }

  async analyzeSlice(request) {
    const {
      sliceId, prompt, systemPrompt = null, schema = null, runDir,
      workDir = null, sourceExposure = "static-only",
    } = request;

    const workspace = workDir ?? createIsolatedWorkspace(`codex-${sliceId}`);
    const mcpLog = path.join(workspace, "mcp-access.json");
    const descriptor = mcpServerDescriptor(runDir, { logPath: mcpLog, sourceExposure });
    const lastMessage = path.join(workspace, "last-message.txt");

    const args = [
      "--ask-for-approval", "never",
      "exec",
      "--sandbox", "read-only",
      "--skip-git-repo-check",
      "--color", "never",
      "--cd", workspace,
      "--output-last-message", lastMessage,
      "-c", `mcp_servers.contextkit.command=${toml(descriptor.command)}`,
      "-c", `mcp_servers.contextkit.args=${JSON.stringify(descriptor.args)}`,
    ];
    if (this.model) args.push("--model", this.model);
    if (schema) {
      const schemaPath = path.join(workspace, "output-schema.json");
      fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2));
      args.push("--output-schema", schemaPath);
    }
    args.push("-");

    // Codex has no system-prompt flag, so the system text is prepended to the prompt.
    const composed = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

    const startedAt = Date.now();
    const outcome = await run(this.binary, args, {
      cwd: workspace, input: composed, timeoutMs: this.timeoutMs,
    });
    const durationMs = Date.now() - startedAt;

    const transcriptPath = path.join(workspace, "transcript.json");
    fs.writeFileSync(transcriptPath, JSON.stringify({
      args, stdout: outcome.stdout, stderr: outcome.stderr, status: outcome.status,
    }, null, 2));

    if (!outcome.ok) {
      throw new ProviderError(
        outcome.timedOut ? `codex timed out after ${this.timeoutMs}ms` : "codex exited non-zero",
        { provider: this.name, stage: "invoke", stderr: outcome.stderr || outcome.stdout,
          code: outcome.status });
    }

    const text = fs.existsSync(lastMessage) ? fs.readFileSync(lastMessage, "utf8") : outcome.stdout;

    return analysisResult({
      provider: this.name,
      model: this.model,
      sliceId,
      result: extractJson(text),
      raw: text,
      durationMs,
      transcriptPath,
      mcpReport: readAccessLog(mcpLog),
    });
  }
}
