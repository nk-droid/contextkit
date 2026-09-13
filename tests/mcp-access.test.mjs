/**
 * MCP source-server access tests.
 *
 * The exit criterion for this layer is negative: a provider must be able to analyze a
 * detached snapshot, and must fail safely when it reaches for anything else. So most of
 * these tests assert on denials - cross-run ids, host paths, oversized calls, sensitive
 * content, and invented evidence.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { scanRepository } from "../src/analysis/scan-repository.mjs";
import { RunStore } from "../src/analysis/mcp/run-store.mjs";
import { ContextKitMcpServer } from "../src/analysis/mcp/server.mjs";
import { LIMITS, applyResponseBudget } from "../src/analysis/mcp/access-policy.mjs";
import {
  CooperativeProvider, FabricatingProvider, GreedyProvider, OverwritingProvider,
  PathProbingProvider, SelfCertifyingProvider,
} from "../src/analysis/mcp/fake-provider.mjs";

let fixture;
let store;
let server;

/**
 * Canaries, not imitation secrets. Redaction is proven by a token being present in the
 * cache and absent from every response, which works regardless of whether the token
 * looks like a real credential - and a string shaped like a real vendor key gets a push
 * blocked by secret scanning, which is a cost with no matching benefit.
 *
 * One canary per sensitivity rule: `.env` is caught by filename, config.ts by content.
 */
const CANARY_BY_FILENAME = "canary-filename-rule-must-not-appear-in-output";
const CANARY_BY_CONTENT = "canary-content-rule-must-not-appear-in-output";

function write(rel, content) {
  const full = path.join(fixture, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** The server is handed a detached snapshot, never a repository path. */
function detach(root) {
  const { document, sourceIndex } = scanRepository(root);
  return new RunStore(JSON.parse(JSON.stringify(document)), sourceIndex.chunks);
}

before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "ck-mcp-"));
  write("package.json", JSON.stringify({
    name: "mcp-fixture", version: "1.0.0", dependencies: { zod: "^3.0.0" },
  }, null, 2));
  write("src/store.ts", [
    "export function openConnection(url) {",
    "  return { url };",
    "}",
    "",
    "export function loadUser(id) {",
    "  const conn = openConnection(process.env.DATABASE_URL);",
    "  return conn;",
    "}",
    "",
  ].join("\n"));
  write("src/app/api/users/route.ts", [
    'import { loadUser } from "../../../store";',
    "",
    "export function GET(request) {",
    "  return loadUser(request.id);",
    "}",
    "",
  ].join("\n"));
  // Two fixtures, because sensitivity has two independent rules and a realistic-looking
  // value would trip secret scanners on the way to the remote for no added coverage:
  // what the test needs is a token it can search for in the output, not a plausible key.
  write(".env", `DEPLOY_KEY="${CANARY_BY_FILENAME}"\n`);
  write("src/config.ts", `export const token = "${CANARY_BY_CONTENT}";\n`);
  store = detach(fixture);
  server = new ContextKitMcpServer(store);
});

after(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

describe("run isolation", () => {
  test("the run id is opaque and carries no host path", () => {
    assert.match(store.runId, /^run_[0-9a-f]{16}$/);
    assert.ok(!store.runId.includes(path.sep));
    assert.ok(!JSON.stringify(store.summary()).includes(fixture));
  });

  test("a session refuses ids belonging to another run", () => {
    const other = `run_${"0".repeat(16)}`;
    const response = server.readResource(`contextkit://runs/${other}/static`);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "cross-run-rejected");
  });

  test("a second run over the same tree is addressable on its own store only", () => {
    const twin = new ContextKitMcpServer(detach(fixture));
    assert.equal(twin.runId, server.runId, "the id is derived from the tree, not the clock");
    write("src/extra.ts", "export function extra() { return 1; }\n");
    const changed = new ContextKitMcpServer(detach(fixture));
    assert.notEqual(changed.runId, server.runId, "a different tree is a different run");
    assert.equal(
      changed.readResource(`contextkit://runs/${server.runId}/static`).error.code,
      "cross-run-rejected",
    );
    fs.rmSync(path.join(fixture, "src/extra.ts"));
  });
});

describe("host filesystem is unreachable", () => {
  for (const hostile of [
    "/etc/passwd",
    "../../etc/passwd",
    "file:///etc/passwd",
    "C:\\Windows\\System32\\config\\sam",
  ]) {
    test(`refuses ${hostile}`, () => {
      const viaChunk = server.callTool("get_source_chunks", { chunkIds: [hostile] });
      assert.equal(viaChunk.ok, false);
      assert.equal(viaChunk.error.code, "host-path-rejected");

      const viaFind = server.callTool("find_chunks", { path: hostile });
      assert.equal(viaFind.ok, false);
      assert.equal(viaFind.error.code, "host-path-rejected");
    });
  }

  test("a path inside the repository but outside the inventory is still refused", () => {
    const response = server.callTool("find_chunks", { path: "src/not-scanned.ts" });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "unknown-record");
  });

  test("an unknown record id returns a denial rather than an empty success", () => {
    const response = server.callTool("get_neighbors", { id: "sym.made.up" });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "unknown-record");
  });
});

describe("resources", () => {
  test("lists a resource per detection collection", () => {
    const uris = server.listResources().map((r) => r.uri);
    assert.ok(uris.some((u) => u.endsWith("/static")));
    assert.ok(uris.some((u) => u.endsWith("/detections/routes")));
  });

  test("static carries coverage without the repository contents", () => {
    const response = server.readResource(`contextkit://runs/${server.runId}/static`);
    assert.equal(response.ok, true);
    assert.ok(response.result.inspection);
    assert.equal(response.result.inventory, undefined);
  });

  test("the entity registry names every addressable id", () => {
    const registry = server.readResource(`contextkit://runs/${server.runId}/entity-registry`).result;
    assert.ok(registry.symbols.length > 0);
    for (const id of registry.symbols) assert.ok(store.recordsById.has(id));
  });

  test("an unknown detection collection is a denial", () => {
    const response = server.readResource(`contextkit://runs/${server.runId}/detections/unicorns`);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "unknown-resource");
  });
});

describe("sensitivity", () => {
  test("both sensitivity rules produce redacted chunks", () => {
    const sensitive = [...store.chunksById.values()].filter((c) => c.sensitive);
    const rules = new Set(sensitive.map((c) => c.sensitiveRuleId));
    assert.ok(rules.has("sensitive.filename"), `.env is caught by name; saw ${[...rules]}`);
    assert.ok([...rules].some((r) => r.startsWith("sensitive.content-")),
      `config.ts is caught by content; saw ${[...rules]}`);

    for (const source of sensitive) {
      const chunk = server.callTool("get_source_chunks", { chunkIds: [source.chunkId] })
        .result.chunks[0];
      assert.equal(chunk.content, null);
      assert.equal(chunk.redacted, true);
      assert.ok(chunk.contentSha256, "the hash survives so the region stays checkable");
    }
  });

  test("no response anywhere leaks either canary", () => {
    const surfaces = [
      server.readResource(`contextkit://runs/${server.runId}/static`),
      server.readResource(`contextkit://runs/${server.runId}/inventory`),
      server.readResource(`contextkit://runs/${server.runId}/code`),
      server.readResource(`contextkit://runs/${server.runId}/entity-registry`),
      server.callTool("search_facts", { query: "env" }),
      server.callTool("search_facts", { query: "token" }),
      server.callTool("search_facts", { query: "canary" }),
      server.callTool("find_chunks", { path: ".env" }),
      server.callTool("find_chunks", { path: "src/config.ts" }),
    ];
    for (const surface of surfaces) {
      const serialized = JSON.stringify(surface);
      for (const canary of [CANARY_BY_FILENAME, CANARY_BY_CONTENT]) {
        assert.ok(!serialized.includes(canary), `a canary escaped through ${serialized.slice(0, 80)}`);
      }
    }
  });

  test("the canaries really are in the cache, so the checks above can fail", () => {
    // Guards against the leak tests passing because the fixture never had the values.
    const raw = JSON.stringify([...store.chunksById.values()].map((c) => c.contentSha256));
    assert.ok(raw.length > 0);
    assert.equal(
      fs.readFileSync(path.join(fixture, ".env"), "utf8").includes(CANARY_BY_FILENAME), true);
    assert.equal(
      fs.readFileSync(path.join(fixture, "src/config.ts"), "utf8").includes(CANARY_BY_CONTENT), true);
  });

  test("evidence cannot be materialized from a sensitive region", () => {
    const sensitive = [...store.chunksById.values()].find((c) => c.sensitive);
    const response = server.callTool("resolve_evidence", {
      chunkId: sensitive.chunkId, detail: "declares a key",
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "sensitive-content");
  });
});

describe("response budgets", () => {
  test("oversized batch requests are refused, not silently trimmed", () => {
    const ids = Array.from({ length: LIMITS.maxRecordsPerCall + 1 }, (_, i) => `sym.x${i}`);
    const records = server.callTool("get_records", { ids });
    assert.equal(records.error.code, "limit-exceeded");

    const chunkIds = Array.from({ length: LIMITS.maxChunksPerCall + 1 }, (_, i) => `ch.x${i}`);
    assert.equal(server.callTool("get_source_chunks", { chunkIds }).error.code, "limit-exceeded");
  });

  test("a response over the byte budget reports that it was truncated", () => {
    const big = Array.from({ length: 40 }, (_, i) => ({
      id: `x${i}`, blob: "y".repeat(16 * 1024),
    }));
    const budgeted = applyResponseBudget(big);
    assert.equal(budgeted.truncated, true);
    assert.ok(budgeted.items.length < big.length);
    assert.ok(budgeted.bytes <= LIMITS.maxResponseBytes);
  });

  test("neighbour depth is clamped to the policy maximum", () => {
    const symbol = store.document.code.symbols.find((s) => store.neighbours.has(s.id));
    const response = server.callTool("get_neighbors", { id: symbol.id, depth: 99 });
    assert.equal(response.ok, true);
    for (const edge of response.result.neighbors) {
      assert.ok(edge.depth <= LIMITS.maxNeighborDepth);
    }
  });
});

describe("analysis without filesystem access", () => {
  test("a provider can reach source text by id alone", () => {
    const symbol = store.document.code.symbols.find((s) => s.path === "src/store.ts");
    const chunks = server.callTool("find_chunks", { symbolId: symbol.id }).result.chunks;
    assert.ok(chunks.length > 0);
    assert.ok(chunks.some((c) => (c.content ?? "").includes("openConnection")));
  });

  test("search finds detections, symbols, and files", () => {
    const hits = server.callTool("search_facts", { query: "loadUser" }).result.matches;
    assert.ok(hits.some((h) => h.kind === "code.symbols"));
    const files = server.callTool("search_facts", { query: "route.ts" }).result.matches;
    assert.ok(files.some((h) => h.kind === "files"));
  });

  test("call edges are walkable in both directions", () => {
    const caller = store.document.code.symbols.find((s) => s.name === "loadUser");
    const out = server.callTool("get_neighbors", { id: caller.id, edgeKinds: ["calls"] }).result;
    assert.ok(out.neighbors.some((n) => n.record?.name === "openConnection"));
    const callee = store.document.code.symbols.find((s) => s.name === "openConnection");
    const back = server.callTool("get_neighbors", { id: callee.id, edgeKinds: ["called-by"] }).result;
    assert.ok(back.neighbors.some((n) => n.record?.name === "loadUser"));
  });
});

describe("detachment", () => {
  test("a snapshot stays fully analyzable after the repository is deleted", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ck-detach-"));
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ck-detach-out-"));
    fs.writeFileSync(path.join(scratch, "package.json"), '{"name":"gone","version":"1.0.0"}');
    fs.mkdirSync(path.join(scratch, "src"));
    fs.writeFileSync(path.join(scratch, "src/main.ts"),
      "export function boot() {\n  return start();\n}\n\nexport function start() {\n  return 1;\n}\n");

    const { document, sourceIndex } = scanRepository(scratch);
    fs.writeFileSync(path.join(outDir, "STATIC_ANALYSIS.json"), JSON.stringify(document));
    fs.writeFileSync(path.join(outDir, "SOURCE_INDEX.jsonl"), sourceIndex.jsonl);

    // The repository is gone from here on. Everything below runs off the cache alone.
    fs.rmSync(scratch, { recursive: true, force: true });
    assert.equal(fs.existsSync(scratch), false);

    const detached = new ContextKitMcpServer(RunStore.fromDirectory(outDir));
    const boot = detached.callTool("search_facts", { query: "boot" }).result.matches
      .find((m) => m.kind === "code.symbols");
    assert.ok(boot, "symbols are still searchable");

    const chunks = detached.callTool("find_chunks", { symbolId: boot.id }).result.chunks;
    assert.ok(chunks.some((c) => (c.content ?? "").includes("function boot")),
      "source text is served from the cache, not the deleted file");

    const evidence = detached.callTool("resolve_evidence", {
      chunkId: chunks[0].chunkId, detail: "declares the entrypoint",
    }).result;
    assert.match(evidence.id, /^ev\./);
    assert.ok(evidence.excerpt.length > 0);

    fs.rmSync(outDir, { recursive: true, force: true });
  });
});

describe("evidence resolution", () => {
  test("evidence is minted from cached content, not from the caller's claim", () => {
    const chunk = [...store.chunksById.values()].find(
      (c) => !c.sensitive && c.path === "src/store.ts");
    const record = server.callTool("resolve_evidence", {
      chunkId: chunk.chunkId, lineStart: chunk.lineStart, lineEnd: chunk.lineStart,
      detail: "declares the connection helper",
      excerpt: "TOTALLY MADE UP", id: "ev.forged", excerptSha256: "0".repeat(64),
    }).result;
    assert.notEqual(record.id, "ev.forged");
    assert.notEqual(record.excerpt, "TOTALLY MADE UP");
    assert.match(record.id, /^ev\./);
    assert.equal(record.verificationStatus, "not-checked");
    assert.ok(chunk.content.includes(record.excerpt.split("\n")[0].trim()));
  });

  test("a range outside the cached chunk is refused", () => {
    const chunk = [...store.chunksById.values()].find((c) => !c.sensitive);
    const response = server.callTool("resolve_evidence", {
      chunkId: chunk.chunkId, lineStart: 1, lineEnd: chunk.lineEnd + 5000, detail: "everything",
    });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "range-outside-chunk");
  });

  test("evidence without a detail is refused", () => {
    const chunk = [...store.chunksById.values()].find((c) => !c.sensitive);
    const response = server.callTool("resolve_evidence", { chunkId: chunk.chunkId });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "bad-request");
  });
});

describe("slice validation", () => {
  const target = () => store.document.code.symbols[0].id;
  const codes = (r) => r.violations.map((v) => v.code);

  test("a candidate citing unknown evidence is rejected", () => {
    const response = server.callTool("validate_slice", {
      sliceId: "architecture",
      candidate: {
        annotations: [{
          targetId: target(), basis: "observed", evidenceIds: ["ev.nope"],
          fields: { summary: "s" },
        }],
      },
    }).result;
    assert.equal(response.valid, false);
    assert.ok(codes(response).includes("unresolved-evidence"));
  });

  test("an observed claim with no evidence is rejected", () => {
    const response = server.callTool("validate_slice", {
      sliceId: "architecture",
      candidate: {
        annotations: [{ targetId: target(), basis: "observed", evidenceIds: [], fields: { summary: "s" } }],
      },
    }).result;
    assert.equal(response.valid, false);
    assert.ok(codes(response).includes("observed-without-evidence"));
  });

  test("a candidate may not mark its own claims verified", () => {
    const response = server.callTool("validate_slice", {
      sliceId: "architecture",
      candidate: {
        annotations: [{
          targetId: target(), basis: "inferred", verificationStatus: "verified",
          fields: { summary: "s" },
        }],
      },
    }).result;
    assert.equal(response.valid, false);
    assert.ok(codes(response).includes("premature-verification"));
  });

  // The reason validate_slice delegates to the merge layer: a provider must not be able
  // to get a protected field past the pre-flight check and have it die at assembly.
  test("a candidate rewriting a measured fact is rejected here, not only at merge", () => {
    const response = server.callTool("validate_slice", {
      sliceId: "architecture",
      candidate: {
        annotations: [{ targetId: target(), basis: "inferred", fields: { lineStart: 1 } }],
      },
    }).result;
    assert.equal(response.valid, false);
    assert.ok(codes(response).includes("protected-field"));
  });

  test("evidence resolved this session counts as grounding", () => {
    const chunk = [...store.chunksById.values()].find((c) => !c.sensitive);
    const evidence = server.callTool("resolve_evidence", {
      chunkId: chunk.chunkId, detail: "declares the module", lineEnd: chunk.lineStart,
    }).result;
    const response = server.callTool("validate_slice", {
      sliceId: "runtime-flow",
      candidate: {
        annotations: [{
          targetId: target(), basis: "observed", evidenceIds: [evidence.id],
          fields: { summary: "Loads a user." },
        }],
      },
    }).result;
    assert.equal(response.valid, true, JSON.stringify(response.violations));
    assert.ok(server.report().acceptedSlices.includes("runtime-flow"));
  });

  test("a slice bound to a different artifact is rejected", () => {
    const response = server.callTool("validate_slice", {
      sliceId: "architecture",
      candidate: { artifactId: "artifact.elsewhere", annotations: [] },
    }).result;
    assert.equal(response.valid, false);
    assert.ok(codes(response).includes("artifact-mismatch"));
  });
});

describe("disputes", () => {
  test("a dispute must name a record in this run", () => {
    const response = server.callTool("report_dispute", { targetId: "sym.nope", reason: "wrong" });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "unknown-record");
  });

  test("a recorded dispute reaches the run report", () => {
    const symbol = store.document.code.symbols[0];
    const response = server.callTool("report_dispute", {
      targetId: symbol.id, field: "kind", reason: "the declaration is re-exported, not defined here",
    });
    assert.equal(response.ok, true);
    assert.ok(server.report().disputes.some((d) => d.targetId === symbol.id));
  });
});

describe("static-only exposure policy", () => {
  // The settled policy: a provider receives STATIC_ANALYSIS.json facts and the short
  // excerpts already carried by evidence records. The private source index is never
  // loaded, so it cannot be served by mistake.
  let staticOnly;

  before(() => {
    const { document } = scanRepository(fixture);
    staticOnly = new ContextKitMcpServer(
      new RunStore(JSON.parse(JSON.stringify(document)), [], { sourceIndexLoaded: false }));
  });

  test("the session reports holding no cached source", () => {
    assert.equal(staticOnly.store.summary().sourceExposure, "static-only");
    assert.equal(staticOnly.store.chunksById.size, 0);
  });

  test("chunk tools are not offered at all", () => {
    const names = staticOnly.listTools().map((t) => t.name);
    assert.ok(!names.includes("get_source_chunks"));
    assert.ok(!names.includes("find_chunks"));
    // A tool that can only deny wastes turns and reads as a malfunction.
    assert.ok(names.includes("search_facts") && names.includes("get_records"));
  });

  test("calling them anyway is refused with the policy named", () => {
    for (const [name, args] of [
      ["get_source_chunks", { chunkIds: ["chunk.whatever"] }],
      ["find_chunks", { path: "src/store.ts" }],
    ]) {
      const response = staticOnly.callTool(name, args);
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "source-not-exposed");
      assert.equal(response.error.detail.policy, "static-only");
    }
  });

  test("resolve_evidence selects an existing record instead of cutting a new one", () => {
    const existing = staticOnly.store.document.evidence.find((e) => e.excerpt);
    const response = staticOnly.callTool("resolve_evidence", { evidenceId: existing.id });
    assert.equal(response.ok, true);
    assert.equal(response.result.id, existing.id);
    assert.equal(response.result.excerpt, existing.excerpt);

    // A chunk range is meaningless here and must not silently succeed.
    const byRange = staticOnly.callTool("resolve_evidence", {
      chunkId: "chunk.whatever", lineStart: 1, lineEnd: 2, detail: "something",
    });
    assert.equal(byRange.ok, false);
    assert.equal(byRange.error.code, "source-not-exposed");
  });

  test("an invented evidence id is still refused", () => {
    const response = staticOnly.callTool("resolve_evidence", { evidenceId: "ev.made.up.deadbeef" });
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "unknown-record");
  });

  test("no response carries a whole cached region", () => {
    // The exposure the policy actually cares about: bounded excerpts, never file bodies.
    const surfaces = [
      staticOnly.readResource(`contextkit://runs/${staticOnly.runId}/code`),
      staticOnly.readResource(`contextkit://runs/${staticOnly.runId}/inventory`),
      staticOnly.callTool("search_facts", { query: "loadUser" }),
    ];
    for (const surface of surfaces) {
      assert.ok(!JSON.stringify(surface).includes("chunk."),
        "a chunk id leaked into a static-only response");
    }
    for (const record of staticOnly.store.document.evidence) {
      if (record.excerpt) assert.ok(record.excerpt.length <= 500, "excerpts stay bounded");
    }
  });

  test("cached-source mode still works, so the policy is a choice and not a rewrite", () => {
    assert.equal(server.store.summary().sourceExposure, "cached-source");
    const names = server.listTools().map((t) => t.name);
    assert.ok(names.includes("get_source_chunks") && names.includes("find_chunks"));
  });
});

describe("fake providers", () => {
  test("a cooperative provider completes a slice through the documented surface alone", () => {
    const fresh = new ContextKitMcpServer(store);
    const run = new CooperativeProvider({ query: "loadUser" }).analyzeSlice(fresh);
    assert.ok(run.result?.valid, JSON.stringify(run.result?.errors ?? run.transcript));
    assert.ok(run.transcript.every((c) => c.ok), "no step needed a denied call");
    assert.equal(fresh.report().denied, 0);
  });

  test("a fabricating provider cannot get invented evidence accepted", () => {
    const fresh = new ContextKitMcpServer(store);
    const response = new FabricatingProvider().analyzeSlice(fresh);
    assert.equal(response.result.valid, false);
    // Assert on the code, not the wording: the code is the contract a caller branches on.
    assert.ok(response.result.violations.some((v) => v.code === "unresolved-evidence"),
      JSON.stringify(response.result.violations));
    assert.equal(fresh.candidates.size, 0, "nothing entered the candidate area");
  });

  test("a provider cannot overwrite a measured fact", () => {
    const fresh = new ContextKitMcpServer(store);
    const response = new OverwritingProvider().analyzeSlice(fresh);
    assert.equal(response.result.valid, false);
    const fields = response.result.violations
      .filter((v) => v.code === "protected-field").map((v) => v.field);
    assert.deepEqual(fields.sort(), ["lineStart", "path"]);
    assert.equal(fresh.candidates.size, 0);
  });

  test("a path-probing provider is denied on every attempt", () => {
    const fresh = new ContextKitMcpServer(store);
    const responses = new PathProbingProvider().analyzeSlice(fresh);
    for (const response of responses) {
      assert.equal(response.ok, false, JSON.stringify(response));
      assert.ok(["host-path-rejected", "cross-run-rejected", "unknown-record", "unknown-resource"]
        .includes(response.error.code), response.error.code);
    }
    assert.equal(fresh.report().denied, responses.length);
  });

  test("a greedy provider is capped rather than served the whole cache", () => {
    const fresh = new ContextKitMcpServer(store);
    const run = new GreedyProvider().analyzeSlice(fresh, store);
    if (store.chunksById.size > LIMITS.maxChunksPerCall) {
      assert.equal(run.bulkChunks.error.code, "limit-exceeded");
    }
    assert.ok(run.deepWalk.result.neighbors.length <= LIMITS.maxNeighborResults);
    assert.ok(run.wideSearch.result.matches.length <= LIMITS.maxSearchResults);
  });

  test("a self-certifying provider cannot mark its own claims verified", () => {
    const fresh = new ContextKitMcpServer(store);
    const response = new SelfCertifyingProvider().analyzeSlice(fresh);
    assert.equal(response.result.valid, false);
  });

  test("no provider can mutate the static artifact", () => {
    const before = JSON.stringify(store.document);
    const fresh = new ContextKitMcpServer(store);
    new CooperativeProvider({ query: "loadUser" }).analyzeSlice(fresh);
    new FabricatingProvider().analyzeSlice(fresh);
    new PathProbingProvider().analyzeSlice(fresh);
    new GreedyProvider().analyzeSlice(fresh, store);
    assert.equal(JSON.stringify(store.document), before);

    // Shallow freezing would leave every nested record writable, so check depth.
    assert.throws(() => { store.document.repository.name = "hijacked"; });
    assert.throws(() => { store.document.code.symbols[0].name = "hijacked"; });
    assert.throws(() => { store.document.inventory.files.push({ path: "planted.ts" }); });

    // Both the direct and the redacted path hand back immutable records.
    const sensitive = [...store.chunksById.values()].find((c) => c.sensitive);
    const plain = [...store.chunksById.values()].find((c) => !c.sensitive);
    for (const source of [sensitive, plain]) {
      const served = fresh.callTool("get_source_chunks", { chunkIds: [source.chunkId] })
        .result.chunks[0];
      assert.throws(() => { served.content = "rewritten"; },
        `a served ${source.sensitive ? "redacted" : "cached"} chunk is not editable`);
      assert.equal(store.chunksById.get(source.chunkId).content, source.content,
        "the cache is unchanged either way");
    }
  });

  test("a submitted candidate is readable at its validation resource", () => {
    const fresh = new ContextKitMcpServer(store);
    const pending = fresh.readResource(`contextkit://runs/${fresh.runId}/validation/architecture`).result;
    assert.equal(pending.status, "not-submitted");

    new CooperativeProvider({ query: "loadUser" }).analyzeSlice(fresh);
    const accepted = fresh.readResource(`contextkit://runs/${fresh.runId}/validation/architecture`).result;
    assert.equal(accepted.status, "accepted");
    assert.ok(accepted.candidate.annotations.length > 0);
    assert.equal(accepted.lastResult.valid, true);
  });
});

describe("access log", () => {
  test("every call - allowed and denied - is logged for the run report", () => {
    const fresh = new ContextKitMcpServer(store);
    fresh.readResource(`contextkit://runs/${fresh.runId}/static`);
    fresh.callTool("get_source_chunks", { chunkIds: ["/etc/passwd"] });
    fresh.callTool("nonexistent_tool", {});

    const report = fresh.report();
    assert.equal(report.calls, 3);
    assert.equal(report.denied, 2);
    assert.equal(report.deniedByCode["host-path-rejected"], 1);
    assert.equal(report.deniedByCode["unknown-tool"], 1);
    assert.ok(report.accessLog.every((e) => e.runId === fresh.runId && e.at));
  });

  test("the log records parameters without echoing host paths back into the artifact", () => {
    const fresh = new ContextKitMcpServer(store);
    fresh.callTool("search_facts", { query: "route" });
    assert.ok(!JSON.stringify(fresh.report()).includes(fixture));
  });
});
