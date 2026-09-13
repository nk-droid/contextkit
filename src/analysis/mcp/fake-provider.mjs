/**
 * Fake analysis providers.
 *
 * Phase 5 requires the server to be exercised by providers before a live model is
 * attached. These stand in for one: a cooperative provider that works only through the
 * documented surface, and hostile ones that behave the way a confused or jailbroken
 * model actually does - inventing citations, reaching for host paths, and asking for
 * the whole cache in one call.
 *
 * They are deliberately dumb. Their job is to prove the boundary holds regardless of
 * what comes through it, not to produce a good analysis.
 */

/**
 * Works entirely through ids: searches, walks edges, pulls chunks, resolves evidence
 * from what it was actually given, and submits a candidate grounded in that evidence.
 */
export class CooperativeProvider {
  constructor({ query = "route", sliceId = "architecture" } = {}) {
    this.query = query;
    this.sliceId = sliceId;
  }

  analyzeSlice(server) {
    const transcript = [];
    const call = (name, params) => {
      const response = server.callTool(name, params);
      transcript.push({ name, ok: response.ok, code: response.error?.code ?? null });
      return response;
    };

    const matches = call("search_facts", { query: this.query, limit: 10 }).result?.matches ?? [];
    const symbol = matches.find((m) => m.kind === "code.symbols");
    if (!symbol) return { transcript, submitted: null, result: null };

    const neighbors = call("get_neighbors", { id: symbol.id, depth: 2 }).result?.neighbors ?? [];
    const chunks = call("find_chunks", { symbolId: symbol.id }).result?.chunks ?? [];
    const readable = chunks.find((c) => c.content);
    if (!readable) return { transcript, submitted: null, result: null };

    const evidence = call("resolve_evidence", {
      chunkId: readable.chunkId,
      lineStart: readable.lineStart,
      lineEnd: Math.min(readable.lineStart + 3, readable.lineEnd),
      detail: `declares ${symbol.record?.name ?? symbol.id}`,
    }).result;

    const candidate = {
      components: [{
        name: symbol.record?.name ?? symbol.id,
        basis: "observed",
        evidenceIds: [evidence.id],
        symbolIds: [symbol.id, ...neighbors.map((n) => n.to)],
      }],
    };
    const result = call("validate_slice", { sliceId: this.sliceId, candidate }).result;
    return { transcript, submitted: candidate, result };
  }
}

/**
 * Cites evidence it never resolved, with a plausible-looking id. This is the failure
 * mode the evidence registry exists to catch.
 */
export class FabricatingProvider {
  analyzeSlice(server) {
    return server.callTool("validate_slice", {
      sliceId: "architecture",
      candidate: {
        components: [{
          name: "PaymentService",
          basis: "observed",
          evidenceIds: ["ev.src-payments.ts.declaration.deadbeef"],
        }],
      },
    });
  }
}

/** Tries to read the host filesystem through every parameter that takes a string. */
export class PathProbingProvider {
  analyzeSlice(server) {
    return [
      server.readResource("contextkit://runs/../../../etc/passwd"),
      server.callTool("find_chunks", { path: "/etc/passwd" }),
      server.callTool("get_source_chunks", { chunkIds: ["../../../.ssh/id_rsa"] }),
      server.callTool("get_records", { ids: ["file:///etc/shadow"] }),
      server.callTool("search_facts", { query: "/Users" }),
    ];
  }
}

/** Asks for everything at once, which is how a cache gets exfiltrated by accident. */
export class GreedyProvider {
  analyzeSlice(server, store) {
    const allChunks = [...store.chunksById.keys()];
    return {
      bulkChunks: server.callTool("get_source_chunks", { chunkIds: allChunks }),
      deepWalk: server.callTool("get_neighbors", {
        id: store.document.code.symbols[0]?.id, depth: 50, limit: 100000,
      }),
      wideSearch: server.callTool("search_facts", { query: "e", limit: 100000 }),
    };
  }
}

/** Claims its own output is verified, skipping the verification stage entirely. */
export class SelfCertifyingProvider {
  analyzeSlice(server) {
    return server.callTool("validate_slice", {
      sliceId: "architecture",
      candidate: {
        components: [{ name: "Core", basis: "inferred", verificationStatus: "verified" }],
      },
    });
  }
}
