/**
 * ContextKit MCP source server (transport-neutral core).
 *
 * Serves one frozen run as read-only resources and tools. Deliberately contains no
 * transport code so it can be driven by a stdio MCP wrapper, an in-process fake
 * provider, or a test - the access rules are identical in every case.
 *
 * The server can read the cache and append to its own log. It cannot mutate the static
 * artifact, and it has no filesystem access to the scanned repository at all.
 */
import {
  AccessDenied, LIMITS, applyResponseBudget, assertKnownRecord, assertNoHostPath,
  assertRunScope, clampLimit, redactChunk, redactEvidence,
} from "./access-policy.mjs";
import { evidenceId, sha256 } from "../stable-ids.mjs";
import { buildProtectedSnapshot, validateAnnotations } from "../merge/protected-fields.mjs";

const RESOURCE_PREFIX = "contextkit://runs/";

export class ContextKitMcpServer {
  /** @param {import("./run-store.mjs").RunStore} store */
  constructor(store, { limits = LIMITS } = {}) {
    this.store = store;
    this.limits = limits;
    this.runId = store.runId;
    this.accessLog = [];
    // Evidence the provider asked to have materialized during analysis. Kept apart
    // from scanner evidence so the run report can show what the model requested.
    this.requestedEvidence = new Map();
    this.candidates = new Map();
    this.validationResults = new Map();
    // Taken at construction, before any provider runs: the values the assembler defends.
    this.snapshot = buildProtectedSnapshot(store.document);
  }

  log(kind, name, params, outcome, detail) {
    this.accessLog.push({
      at: new Date().toISOString(),
      runId: this.runId, kind, name,
      params: JSON.stringify(params ?? {}).slice(0, 400),
      outcome, detail: detail ? String(detail).slice(0, 300) : null,
    });
  }

  /** Wrap a handler so every call - allowed or denied - lands in the run report. */
  #guard(kind, name, params, handler) {
    try {
      const result = handler();
      this.log(kind, name, params, "allowed", null);
      return { ok: true, result };
    } catch (error) {
      if (error instanceof AccessDenied) {
        this.log(kind, name, params, "denied", `${error.code}: ${error.message}`);
        return { ok: false, error: { code: error.code, message: error.message, detail: error.detail } };
      }
      this.log(kind, name, params, "error", error.message);
      return { ok: false, error: { code: "internal-error", message: error.message } };
    }
  }

  // ---------------------------------------------------------------- resources

  listResources() {
    const kinds = Object.keys(this.store.document.detections);
    const base = `${RESOURCE_PREFIX}${this.runId}`;
    return [
      { uri: `${base}/static`, description: "Scanner provenance, repository identity, and inspection coverage." },
      { uri: `${base}/inventory`, description: "Complete file inventory, directories, and language statistics." },
      { uri: `${base}/code`, description: "Retained declarations, call edges, and extraction coverage." },
      { uri: `${base}/entity-registry`, description: "Every addressable record id in this run, by kind." },
      ...kinds.map((kind) => ({
        uri: `${base}/detections/${kind}`,
        description: `Typed ${kind} detections.`,
      })),
      { uri: `${base}/chunks/<chunk-id>`, description: "One cached source chunk. Sensitive chunks omit content." },
      { uri: `${base}/evidence/<evidence-id>`, description: "One canonical evidence record." },
      { uri: `${base}/validation/<slice-id>`, description: "The accepted candidate for a slice, and how it was validated." },
    ];
  }

  readResource(uri) {
    return this.#guard("resource", uri, null, () => {
      assertNoHostPath(String(uri).replace(RESOURCE_PREFIX, ""), "uri");
      if (!String(uri).startsWith(RESOURCE_PREFIX)) {
        throw new AccessDenied("unknown-resource", "resource uris must use the contextkit:// scheme", { uri });
      }
      const rest = String(uri).slice(RESOURCE_PREFIX.length);
      const [runId, section, ...tail] = rest.split("/");
      assertRunScope(this.runId, runId);

      const doc = this.store.document;
      switch (section) {
        case "static":
          return {
            schemaVersion: doc.schemaVersion, artifactId: doc.artifactId,
            scanner: doc.scanner, repository: doc.repository,
            inspection: doc.inspection, diagnostics: doc.diagnostics,
            sourceIndex: doc.sourceIndex,
          };
        case "inventory":
          return doc.inventory;
        case "code":
          return doc.code;
        case "entity-registry":
          return {
            symbols: [...this.store.symbolsById.keys()],
            evidence: [...this.store.evidenceById.keys()],
            detections: Object.fromEntries(
              Object.entries(doc.detections).map(([k, v]) => [k, v.map((r) => r.id)]),
            ),
          };
        case "detections": {
          const kind = tail[0];
          if (!Object.hasOwn(doc.detections, kind)) {
            throw new AccessDenied("unknown-resource", `no detection collection named ${kind}`, { kind });
          }
          return doc.detections[kind];
        }
        case "chunks": {
          const chunk = this.store.chunksById.get(tail.join("/"));
          if (!chunk) throw new AccessDenied("unknown-record", "no such chunk in this run", { id: tail.join("/") });
          return redactChunk(chunk);
        }
        case "evidence": {
          const record = this.store.evidenceById.get(tail.join("/"));
          if (!record) throw new AccessDenied("unknown-record", "no such evidence in this run", { id: tail.join("/") });
          return redactEvidence(record);
        }
        case "validation": {
          // The candidate area, readable so a provider can see what its last submission
          // was judged on. It is never merged into the static artifact from here.
          const sliceId = tail.join("/");
          const accepted = this.candidates.get(sliceId) ?? null;
          return {
            sliceId,
            status: accepted ? "accepted" : "not-submitted",
            candidate: accepted,
            lastResult: this.validationResults.get(sliceId) ?? null,
          };
        }
        default:
          throw new AccessDenied("unknown-resource", `unknown resource section ${section}`, { section });
      }
    });
  }

  // -------------------------------------------------------------------- tools

  listTools() {
    return [
      { name: "search_facts", description: "Search detections, symbols, and files by substring." },
      { name: "get_records", description: "Fetch records by id from this run." },
      { name: "get_source_chunks", description: "Fetch cached source chunks by id." },
      { name: "find_chunks", description: "Find chunks by path, symbol, line range, or role." },
      { name: "get_neighbors", description: "Walk call and declaration edges from a symbol." },
      { name: "resolve_evidence", description: "Materialize canonical evidence from a cached chunk range." },
      { name: "validate_slice", description: "Validate a candidate slice result against this run." },
      { name: "report_dispute", description: "Record a disagreement with a static observation." },
    ];
  }

  callTool(name, params = {}) {
    const handler = this.#tool(name);
    if (!handler) {
      return this.#guard("tool", name, params, () => {
        throw new AccessDenied("unknown-tool", `no tool named ${name}`, { name });
      });
    }
    return this.#guard("tool", name, params, () => handler(params));
  }

  #tool(name) {
    const tools = {
      search_facts: (p) => this.#searchFacts(p),
      get_records: (p) => this.#getRecords(p),
      get_source_chunks: (p) => this.#getSourceChunks(p),
      find_chunks: (p) => this.#findChunks(p),
      get_neighbors: (p) => this.#getNeighbors(p),
      resolve_evidence: (p) => this.#resolveEvidence(p),
      validate_slice: (p) => this.#validateSlice(p),
      report_dispute: (p) => this.#reportDispute(p),
    };
    return tools[name] ?? null;
  }

  #searchFacts({ query, kinds = null, limit } = {}) {
    if (typeof query !== "string" || !query.trim()) {
      throw new AccessDenied("bad-request", "query must be a non-empty string", {});
    }
    assertNoHostPath(query, "query");
    const needle = query.trim().toLowerCase();
    const cap = clampLimit(limit, this.limits.maxSearchResults);
    const hits = [];

    for (const [kind, collection] of Object.entries(this.store.document.detections)) {
      if (kinds && !kinds.includes(kind)) continue;
      for (const record of collection) {
        const hay = JSON.stringify(record).toLowerCase();
        if (hay.includes(needle)) hits.push({ kind, id: record.id, record });
      }
    }
    if (!kinds || kinds.includes("code.symbols")) {
      for (const symbol of this.store.document.code.symbols) {
        if (`${symbol.name} ${symbol.qualifiedName} ${symbol.path}`.toLowerCase().includes(needle)) {
          hits.push({ kind: "code.symbols", id: symbol.id, record: symbol });
        }
      }
    }
    if (!kinds || kinds.includes("files")) {
      for (const file of this.store.document.inventory.files) {
        if (file.path.toLowerCase().includes(needle)) {
          hits.push({ kind: "files", id: file.path, record: file });
        }
      }
    }

    const budgeted = applyResponseBudget(hits.slice(0, cap));
    return { matches: budgeted.items, total: hits.length, truncated: budgeted.truncated || hits.length > cap };
  }

  #getRecords({ ids } = {}) {
    if (!Array.isArray(ids) || !ids.length) {
      throw new AccessDenied("bad-request", "ids must be a non-empty array", {});
    }
    if (ids.length > this.limits.maxRecordsPerCall) {
      throw new AccessDenied("limit-exceeded",
        `at most ${this.limits.maxRecordsPerCall} ids per call`, { requested: ids.length });
    }
    const found = [];
    const missing = [];
    for (const id of ids) {
      assertNoHostPath(id, "id");
      const entry = this.store.recordsById.get(id);
      if (entry) found.push({ kind: entry.kind, id, record: entry.record });
      else if (this.store.evidenceById.has(id)) {
        found.push({ kind: "evidence", id, record: redactEvidence(this.store.evidenceById.get(id)) });
      } else missing.push(id);
    }
    const budgeted = applyResponseBudget(found);
    return { records: budgeted.items, missing, truncated: budgeted.truncated };
  }

  #getSourceChunks({ chunkIds } = {}) {
    if (!Array.isArray(chunkIds) || !chunkIds.length) {
      throw new AccessDenied("bad-request", "chunkIds must be a non-empty array", {});
    }
    if (chunkIds.length > this.limits.maxChunksPerCall) {
      throw new AccessDenied("limit-exceeded",
        `at most ${this.limits.maxChunksPerCall} chunks per call`, { requested: chunkIds.length });
    }
    const chunks = [];
    const missing = [];
    for (const id of chunkIds) {
      assertNoHostPath(id, "chunkId");
      const chunk = this.store.chunksById.get(id);
      if (chunk) chunks.push(redactChunk(chunk));
      else missing.push(id);
    }
    const budgeted = applyResponseBudget(chunks);
    return { chunks: budgeted.items, missing, truncated: budgeted.truncated, omitted: budgeted.omitted };
  }

  #findChunks({ path: relPath = null, symbolId = null, lineStart = null, lineEnd = null, roles = null, limit } = {}) {
    if (relPath !== null) assertNoHostPath(relPath, "path");
    if (symbolId !== null) assertKnownRecord(this.store, symbolId, "symbolId");
    const cap = clampLimit(limit, this.limits.maxChunksPerCall);

    let candidates;
    if (symbolId) {
      const symbol = this.store.symbolsById.get(symbolId);
      if (!symbol) throw new AccessDenied("unknown-record", "no such symbol in this run", { symbolId });
      candidates = this.store.chunksCovering(symbol.path, symbol.lineStart, symbol.lineEnd);
    } else if (relPath) {
      if (!this.store.filesByPath.has(relPath)) {
        throw new AccessDenied("unknown-record", "path is not in this run's inventory", { path: relPath });
      }
      candidates = this.store.chunksByPath.get(relPath) ?? [];
      if (Number.isInteger(lineStart) && Number.isInteger(lineEnd)) {
        candidates = candidates.filter((c) => c.lineEnd >= lineStart && c.lineStart <= lineEnd);
      }
    } else {
      throw new AccessDenied("bad-request", "provide a path or a symbolId", {});
    }
    if (roles) candidates = candidates.filter((c) => c.roles.some((r) => roles.includes(r)));

    const budgeted = applyResponseBudget(candidates.slice(0, cap).map(redactChunk));
    return { chunks: budgeted.items, total: candidates.length, truncated: budgeted.truncated || candidates.length > cap };
  }

  #getNeighbors({ id, edgeKinds = null, depth = 1, limit } = {}) {
    assertKnownRecord(this.store, id, "id");
    const maxDepth = clampLimit(depth, this.limits.maxNeighborDepth, 1);
    const cap = clampLimit(limit, this.limits.maxNeighborResults);

    const seen = new Set([id]);
    const out = [];
    let frontier = [id];
    for (let level = 1; level <= maxDepth && out.length < cap; level += 1) {
      const next = [];
      for (const current of frontier) {
        for (const edge of this.store.neighbours.get(current) ?? []) {
          if (edgeKinds && !edgeKinds.includes(edge.edgeKind)) continue;
          if (seen.has(edge.id)) continue;
          seen.add(edge.id);
          next.push(edge.id);
          out.push({
            from: current, to: edge.id, edgeKind: edge.edgeKind, depth: level,
            record: this.store.symbolsById.get(edge.id) ?? null,
          });
          if (out.length >= cap) break;
        }
        if (out.length >= cap) break;
      }
      frontier = next;
      if (!frontier.length) break;
    }
    const budgeted = applyResponseBudget(out);
    return { neighbors: budgeted.items, truncated: budgeted.truncated || out.length >= cap };
  }

  /**
   * Materialize evidence from the frozen cache.
   *
   * The model may ask for a range and a detail; it may not supply the excerpt, the
   * hash, or the id. Those come from cached content here, which is what stops a
   * provider inventing a citation.
   */
  #resolveEvidence({ chunkId, lineStart, lineEnd, detail } = {}) {
    assertNoHostPath(chunkId, "chunkId");
    const chunk = this.store.chunksById.get(chunkId);
    if (!chunk) throw new AccessDenied("unknown-record", "no such chunk in this run", { chunkId });
    if (typeof detail !== "string" || !detail.trim()) {
      throw new AccessDenied("bad-request", "detail must describe what the region declares", {});
    }
    const start = Number.isInteger(lineStart) ? lineStart : chunk.lineStart;
    const end = Number.isInteger(lineEnd) ? lineEnd : chunk.lineEnd;
    if (start < chunk.lineStart || end > chunk.lineEnd || end < start) {
      throw new AccessDenied("range-outside-chunk",
        "requested range must fall inside the cached chunk",
        { chunk: [chunk.lineStart, chunk.lineEnd], requested: [start, end] });
    }
    if (end - start + 1 > this.limits.maxEvidenceLines) {
      throw new AccessDenied("limit-exceeded", "requested evidence range is too large",
        { lines: end - start + 1, max: this.limits.maxEvidenceLines });
    }
    if (chunk.sensitive) {
      throw new AccessDenied("sensitive-content",
        "this region is marked sensitive; its content cannot be materialized as evidence",
        { chunkId });
    }

    const lines = (chunk.content ?? "").split("\n");
    const excerpt = lines
      .slice(start - chunk.lineStart, end - chunk.lineStart + 1)
      .filter((l) => l.trim() !== "")
      .join("\n")
      .slice(0, 500);
    const id = evidenceId(chunk.path, `req-${start}-${end}`, excerpt || `${chunk.path}:${start}`);
    const record = {
      id, path: chunk.path, sourceKind: "file",
      lineStart: start, lineEnd: end,
      symbol: chunk.symbolIds?.[0] ?? null,
      detail: detail.trim(),
      excerpt,
      excerptSha256: excerpt ? sha256(excerpt) : null,
      fileSha256: chunk.fileSha256,
      sensitive: false,
      verificationStatus: "not-checked",
      requestedByProvider: true,
    };
    this.requestedEvidence.set(id, record);
    return record;
  }

  /**
   * Candidate slice results go to an in-memory candidate area and are checked against
   * this run. They never touch the static artifact.
   *
   * The rules themselves live in the merge layer, not here. This is a pre-flight check
   * a provider can call mid-analysis, and the merge is the gate that actually admits a
   * slice - if the two held separate copies of the rules they would drift, and the
   * drift would show up as a slice that passes here and is rejected at assembly, or
   * worse, the reverse.
   */
  #validateSlice({ sliceId, candidate } = {}) {
    if (typeof sliceId !== "string" || !sliceId) {
      throw new AccessDenied("bad-request", "sliceId is required", {});
    }
    if (!candidate || typeof candidate !== "object") {
      throw new AccessDenied("bad-request", "candidate must be an object", {});
    }

    // Evidence the provider resolved this session is not in the static artifact yet, so
    // the snapshot is extended with it for the duration of the check.
    const snapshot = {
      ...this.snapshot,
      evidenceIds: new Set([...this.snapshot.evidenceIds, ...this.requestedEvidence.keys()]),
    };
    const slice = {
      sliceId,
      artifactId: candidate.artifactId ?? this.snapshot.artifactId,
      treeFingerprint: candidate.treeFingerprint ?? this.snapshot.treeFingerprint,
      annotations: candidate.annotations ?? [],
      entities: candidate.entities ?? [],
    };
    const { valid, violations } = validateAnnotations(slice, snapshot);

    if (valid) this.candidates.set(sliceId, candidate);
    const result = {
      sliceId, valid, violations,
      errors: violations.map((v) => v.message),
      acceptedAt: valid ? new Date().toISOString() : null,
    };
    this.validationResults.set(sliceId, result);
    return result;
  }

  #reportDispute({ targetId, field, reason, evidenceIds = [] } = {}) {
    assertKnownRecord(this.store, targetId, "targetId");
    if (typeof reason !== "string" || !reason.trim()) {
      throw new AccessDenied("bad-request", "reason is required", {});
    }
    for (const id of evidenceIds) {
      if (!this.store.evidenceById.has(id) && !this.requestedEvidence.has(id)) {
        throw new AccessDenied("unknown-record", "dispute cites unknown evidence", { id });
      }
    }
    const dispute = {
      targetId, field: field ?? null, reason: reason.trim(), evidenceIds,
      recordedAt: new Date().toISOString(),
    };
    (this.disputes ??= []).push(dispute);
    return { recorded: true, dispute };
  }

  /** What the provider touched, for the run report. */
  report() {
    const denied = this.accessLog.filter((e) => e.outcome === "denied");
    return {
      runId: this.runId,
      calls: this.accessLog.length,
      denied: denied.length,
      deniedByCode: denied.reduce((acc, e) => {
        const code = (e.detail ?? "").split(":")[0];
        acc[code] = (acc[code] ?? 0) + 1;
        return acc;
      }, {}),
      requestedEvidence: [...this.requestedEvidence.values()],
      disputes: this.disputes ?? [],
      acceptedSlices: [...this.candidates.keys()],
      accessLog: this.accessLog,
    };
  }
}
