/**
 * MCP stdio transport.
 *
 * Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout and forwards every request to a
 * ContextKitMcpServer. Hand-rolled rather than pulled from an SDK: the surface is four
 * methods and a handshake, and the scanner is meant to stay dependency-light.
 *
 * Two rules hold this together. stdout belongs to the protocol - anything else written
 * there corrupts the stream, so diagnostics go to stderr without exception. And the
 * transport makes no access decisions: it translates, and the server decides, so the
 * stdio path and the in-process path cannot diverge on what a provider may reach.
 */
import { createInterface } from "node:readline";

/** The revision of MCP this speaks. Clients negotiate down if they are older. */
export const PROTOCOL_VERSION = "2025-06-18";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

export class StdioTransport {
  /**
   * @param {import("./server.mjs").ContextKitMcpServer} server
   * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream,
   *          log?: (message: string) => void}} [io]
   */
  constructor(server, { input = process.stdin, output = process.stdout, log = null } = {}) {
    this.server = server;
    this.input = input;
    this.output = output;
    this.log = log ?? ((message) => process.stderr.write(`${message}\n`));
    this.initialized = false;
  }

  send(message) {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  reply(id, result) {
    if (id === undefined || id === null) return; // a notification expects no reply
    this.send({ jsonrpc: "2.0", id, result });
  }

  fail(id, code, message, data) {
    if (id === undefined || id === null) return;
    this.send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
  }

  /** Resolve when stdin closes. */
  start() {
    return new Promise((resolve) => {
      const lines = createInterface({ input: this.input, crlfDelay: Infinity });
      lines.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let message;
        try {
          message = JSON.parse(trimmed);
        } catch (error) {
          this.fail(null, PARSE_ERROR, `invalid JSON: ${error.message}`);
          return;
        }
        try {
          this.handle(message);
        } catch (error) {
          this.log(`handler error: ${error.stack ?? error.message}`);
          this.fail(message.id, INTERNAL_ERROR, error.message);
        }
      });
      lines.on("close", resolve);
    });
  }

  handle(message) {
    const { id, method, params = {} } = message;
    if (typeof method !== "string") {
      this.fail(id, INVALID_REQUEST, "method is required");
      return;
    }

    switch (method) {
      case "initialize":
        this.initialized = true;
        this.reply(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "contextkit", version: "0.1.0" },
          // The run this session is bound to. A provider cannot change it.
          instructions: this.instructions(),
        });
        return;

      case "notifications/initialized":
      case "notifications/cancelled":
        return;

      case "ping":
        this.reply(id, {});
        return;

      case "tools/list":
        this.reply(id, { tools: this.server.listTools() });
        return;

      case "tools/call":
        this.reply(id, this.callTool(params));
        return;

      case "resources/list":
        this.reply(id, {
          resources: this.server.listResources()
            // Templated uris are documentation, not listable resources.
            .filter((r) => !r.uri.includes("<"))
            .map((r) => ({ uri: r.uri, name: r.uri.split("/").pop(), description: r.description,
              mimeType: "application/json" })),
        });
        return;

      case "resources/templates/list":
        this.reply(id, {
          resourceTemplates: this.server.listResources()
            .filter((r) => r.uri.includes("<"))
            .map((r) => ({ uriTemplate: r.uri.replace(/<([^>]+)>/g, "{$1}"),
              name: r.uri.split("/").slice(-2)[0], description: r.description,
              mimeType: "application/json" })),
        });
        return;

      case "resources/read":
        this.reply(id, this.readResource(params));
        return;

      default:
        this.fail(id, METHOD_NOT_FOUND, `unknown method: ${method}`);
    }
  }

  /**
   * A denial is a tool result with isError, not a JSON-RPC error.
   *
   * A protocol-level error reads to most clients as "the server broke" and often ends
   * the turn. A denial is a normal, expected answer that the model should read and act
   * on - it says what is not allowed and implies what is, which is the whole point of
   * having a boundary rather than a crash.
   */
  callTool({ name, arguments: args = {} }) {
    const response = this.server.callTool(name, args);
    if (response.ok) {
      return { content: [{ type: "text", text: JSON.stringify(response.result, null, 2) }] };
    }
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({
          denied: response.error.code,
          message: response.error.message,
          detail: response.error.detail ?? null,
          hint: HINTS[response.error.code] ?? null,
        }, null, 2),
      }],
    };
  }

  readResource({ uri }) {
    const response = this.server.readResource(uri);
    const body = response.ok
      ? response.result
      : { denied: response.error.code, message: response.error.message };
    return {
      contents: [{ uri, mimeType: "application/json", text: JSON.stringify(body, null, 2) }],
    };
  }

  instructions() {
    const summary = this.server.store.summary();
    const staticOnly = summary.sourceExposure === "static-only";
    return [
      `You are analyzing a frozen snapshot of ${summary.repository} (run ${summary.runId}).`,
      "",
      "The repository is not on disk and no file tool will find it. Every fact comes from",
      "this server: search_facts to discover ids, get_records to read them, get_neighbors",
      "to follow call edges.",
      "",
      staticOnly
        ? [
          "This session serves static facts only. Cached source is NOT available: do not call",
          "find_chunks or get_source_chunks, they will be refused. Ground observed claims by",
          "citing an evidence id that already appears on a record's evidenceIds - each carries",
          "a short verbatim excerpt and an exact location.",
        ].join("\n")
        : [
          "Use find_chunks and get_source_chunks to read cached source, and resolve_evidence to",
          "turn a range into a canonical evidence id. The excerpt is derived from cached content;",
          "you cannot write evidence yourself.",
        ].join("\n"),
      "",
      "Scanner-measured values such as paths, hashes, line numbers, and call endpoints are",
      "protected: submit only interpretation, and use report_dispute where you think a",
      "measurement is wrong.",
      "",
      `The snapshot holds ${summary.files} files, ${summary.symbols} symbols, and`,
      `${summary.evidence} evidence records`
      + (staticOnly ? "." : `, with ${summary.chunks} source chunks.`),
    ].join("\n");
  }
}

/** What a provider should do instead, per denial code. */
const HINTS = {
  "host-path-rejected": "Use a repository-relative path or a record id; the host filesystem is not reachable.",
  "cross-run-rejected": "This session is bound to one run; use the run id from the resource list.",
  "unknown-record": "Call search_facts to find a valid id.",
  "unknown-resource": "Call resources/list to see what exists.",
  "limit-exceeded": "Request fewer items per call.",
  "sensitive-content": "This region is redacted by policy; cite its location without the content.",
  "source-not-exposed": "Cached source is not served in this session. Cite an existing evidence id from a record's evidenceIds.",
  "range-outside-chunk": "Request a range inside the chunk's own line bounds.",
  "bad-request": "Check the tool's input schema.",
};
