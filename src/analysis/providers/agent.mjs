/**
 * The agent provider: the interactive agent running a ContextKit skill does a slice itself.
 *
 * The Claude Code and Codex adapters launch a headless model in an empty directory and
 * read its answer back. Here the model is already running - it is the agent the user is
 * talking to - so ContextKit prepares the request, logs the calls the agent makes through
 * contextkit-mcp, and reads the result file it submits. Storage, validation, and registry
 * freezing then follow the same path as every other provider.
 *
 * What this cannot do is confine the agent. It may read the repository directly; only the
 * evidence and protected-field rules are enforced, by validation, as for any provider.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../slices/slice-kit.mjs";
import { analysisResult, readAccessLog } from "./provider.mjs";

export const AGENT = "agent";

/**
 * Files for one slice of an agent session, inside the run's analysis directory.
 *
 * contextkit-mcp and contextkit-analyze both derive the log path from here, so the calls
 * the agent makes and the result it submits meet without either side passing a path.
 */
export function agentPaths(workspace, slice) {
  const at = (kind) => workspace.slicePath(slice.order, slice.id, AGENT, kind);
  return {
    prompt: at("prompt").replace(/\.json$/, ".md"),
    schema: at("schema"),
    result: at("result"),
    log: at("mcp-access"),
  };
}

/** The addendum that adapts a slice prompt to an agent working in its own session. */
export function agentInstructions({ runDir, slice, files }) {
  const template = fs.readFileSync(path.join(ROOT, "prompts/analysis/agent-mode.md"), "utf8");
  const values = {
    contextkit: ROOT, run: runDir, slice: slice.id, schema: files.schema, result: files.result,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => values[key] ?? match);
}

export class AgentResultProvider {
  constructor({ resultPath, logPath, preparedPath = null }) {
    this.name = AGENT;
    this.resultPath = resultPath;
    this.logPath = logPath;
    this.preparedPath = preparedPath;
  }

  async available() {
    return "result file";
  }

  async analyzeSlice({ sliceId }) {
    const raw = fs.readFileSync(this.resultPath, "utf8");
    let result;
    try {
      result = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${this.resultPath} is not valid JSON: ${error.message}`);
    }
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error(`${this.resultPath} must hold one JSON object`);
    }
    // Time since the slice was prepared: the nearest thing to a duration for work done in
    // someone else's session.
    const preparedAt = this.preparedPath && fs.existsSync(this.preparedPath)
      ? fs.statSync(this.preparedPath).mtimeMs : null;
    return analysisResult({
      provider: AGENT, model: null, sliceId, result, raw,
      durationMs: preparedAt ? Date.now() - preparedAt : 0,
      mcpReport: readAccessLog(this.logPath),
    });
  }
}
