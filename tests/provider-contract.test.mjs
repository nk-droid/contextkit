/**
 * Provider adapter contract tests.
 *
 * The adapters are the one place where ContextKit hands control to something it does not
 * own, so the contract worth testing is not "does it parse the answer" but "does it ever
 * grant the provider more than it should". Those assertions run against the argv the
 * adapter builds, because that is the whole of what the provider is allowed.
 *
 * Fake CLIs stand in for the real ones: they record their argv, emit a canned response
 * in the provider's own envelope format, and let failure modes - non-zero exit, timeout,
 * malformed output - be exercised deterministically and without spending quota.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { ClaudeCliProvider } from "../src/analysis/providers/claude-cli.mjs";
import { CodexCliProvider } from "../src/analysis/providers/codex-cli.mjs";
import {
  ProviderError, createIsolatedWorkspace, extractJson, mcpServerDescriptor, readAccessLog, run,
} from "../src/analysis/providers/provider.mjs";
import {
  describeExposure, renderActualAccess, renderDisclosure,
} from "../src/analysis/providers/disclosure.mjs";

let bin;
let workRoot;

const ANSWER = { repositoryName: "fixture", fileCount: 3, toolsUsed: ["search_facts"] };

/** Write an executable fake CLI that records argv and behaves as told. */
function fakeCli(name, body) {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

const argvOf = (name) =>
  JSON.parse(fs.readFileSync(path.join(bin, `${name}.argv.json`), "utf8"));

before(() => {
  bin = fs.mkdtempSync(path.join(os.tmpdir(), "ck-fakebin-"));
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ck-provider-"));

  // Claude: --output-format json wraps the answer text in an envelope.
  fakeCli("claude-ok", `
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(path.join(bin, "claude-ok.argv.json"))},
      JSON.stringify(process.argv.slice(2)));
    if (process.argv[2] === "--version") { process.stdout.write("9.9.9 (fake)\\n"); process.exit(0); }
    process.stdout.write(JSON.stringify({
      type: "result", model: "fake-model",
      result: ${JSON.stringify(JSON.stringify(ANSWER))},
      usage: { input_tokens: 10, output_tokens: 20 },
    }));
  `);

  // Codex: the final message goes to the --output-last-message file, not stdout.
  fakeCli("codex-ok", `
    const fs = require("node:fs");
    const argv = process.argv.slice(2);
    fs.writeFileSync(${JSON.stringify(path.join(bin, "codex-ok.argv.json"))}, JSON.stringify(argv));
    if (argv[0] === "--version") { process.stdout.write("codex-cli 9.9.9\\n"); process.exit(0); }
    const at = argv.indexOf("--output-last-message");
    fs.writeFileSync(argv[at + 1], "Here you go:\\n\\n\`\`\`json\\n" +
      ${JSON.stringify(JSON.stringify(ANSWER))} + "\\n\`\`\`\\n");
    process.stdout.write("done\\n");
  `);

  fakeCli("cli-fails", `
    if (process.argv[2] === "--version") { process.stdout.write("9.9.9\\n"); process.exit(0); }
    process.stderr.write("authentication required\\n");
    process.exit(3);
  `);

  fakeCli("cli-garbage", `
    const fs = require("node:fs");
    const argv = process.argv.slice(2);
    if (argv[0] === "--version") { process.stdout.write("9.9.9\\n"); process.exit(0); }
    const at = argv.indexOf("--output-last-message");
    if (at >= 0) fs.writeFileSync(argv[at + 1], "I could not complete that.");
    process.stdout.write("I could not complete that.");
  `);

  fakeCli("cli-hangs", `
    if (process.argv[2] === "--version") { process.stdout.write("9.9.9\\n"); process.exit(0); }
    setTimeout(() => {}, 60000);
  `);
});

after(() => {
  for (const dir of [bin, workRoot]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const request = (overrides = {}) => ({
  sliceId: "contract",
  prompt: "Describe the repository.",
  systemPrompt: "Use only the MCP server.",
  schema: { type: "object", properties: { repositoryName: { type: "string" } } },
  runDir: path.join(workRoot, "run"),
  toolNames: ["search_facts", "get_records"],
  workDir: fs.mkdtempSync(path.join(workRoot, "ws-")),
  ...overrides,
});

describe("the provider is never granted the repository", () => {
  test("claude is given no directory and no filesystem tool", async () => {
    const provider = new ClaudeCliProvider({ binary: path.join(bin, "claude-ok") });
    await provider.analyzeSlice(request());
    const argv = argvOf("claude-ok");

    assert.ok(!argv.includes("--add-dir"),
      "--add-dir would hand the provider the repository the scanner is supposed to own");

    const allowed = argv[argv.indexOf("--allowedTools") + 1].split(",");
    assert.ok(allowed.every((t) => t.startsWith("mcp__contextkit__")),
      `only contextkit tools may be allowed; saw ${allowed}`);

    const withheld = argv[argv.indexOf("--disallowedTools") + 1].split(",");
    for (const tool of ["Read", "Glob", "Grep", "Bash", "Edit", "Write"]) {
      assert.ok(withheld.includes(tool), `${tool} must be withheld`);
    }
  });

  test("claude is pinned to our MCP config alone", async () => {
    const provider = new ClaudeCliProvider({ binary: path.join(bin, "claude-ok") });
    await provider.analyzeSlice(request());
    const argv = argvOf("claude-ok");
    assert.ok(argv.includes("--strict-mcp-config"),
      "without this the provider also loads the user's own MCP servers");

    const config = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8"));
    assert.deepEqual(Object.keys(config.mcpServers), ["contextkit"]);
  });

  test("codex runs read-only in the workspace it is given", async () => {
    const provider = new CodexCliProvider({ binary: path.join(bin, "codex-ok") });
    const req = request();
    await provider.analyzeSlice(req);
    const argv = argvOf("codex-ok");
    assert.equal(argv[argv.indexOf("--sandbox") + 1], "read-only");
    assert.equal(argv[argv.indexOf("--cd") + 1], req.workDir);
    assert.ok(argv.some((a) => a.startsWith("mcp_servers.contextkit.command=")));
  });

  test("the workspace a provider runs in holds no repository content", async () => {
    const workspace = createIsolatedWorkspace("contract");
    const entries = fs.readdirSync(workspace);
    assert.deepEqual(entries, ["README.md"]);
    assert.ok(fs.readFileSync(path.join(workspace, "README.md"), "utf8")
      .includes("not on this filesystem"));
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test("the mcp descriptor points at our stdio server and the given run", () => {
    const descriptor = mcpServerDescriptor("/tmp/some-run", { logPath: "/tmp/log.json" });
    assert.ok(descriptor.args[0].endsWith("bin/contextkit-mcp-stdio"));
    assert.equal(descriptor.args[1], path.resolve("/tmp/some-run"));
    assert.ok(descriptor.args.includes("--log"));
  });
});

describe("disclosure matches what is actually reachable", () => {
  // A disclosure that overstates is alarming; one that understates is a lie about where
  // source went. Both come from the same failure - the number and the policy being
  // computed from different places - so the test ties them together.
  const fakeStore = (sourceIndexLoaded, chunkCount) => ({
    runId: "run_test",
    sourceIndexLoaded,
    chunksById: new Map(),
    document: {
      repository: { name: "fixture" },
      inventory: { files: [{}, {}, {}] },
      code: { symbols: [{}, {}], calls: [{}] },
      detections: { routes: [{}] },
      evidence: [
        { excerpt: "x".repeat(100) },
        { excerpt: "y".repeat(50) },
        { excerpt: null, sensitive: true },
      ],
      sourceIndex: { chunkCount, includedBytes: 500_000 },
    },
  });

  test("static-only reports the source index as withheld, not as reachable", () => {
    const exposure = describeExposure(fakeStore(false, 490));
    assert.equal(exposure.exposure, "static-only");
    assert.equal(exposure.withheldChars, 500_000);

    const text = renderDisclosure(exposure, { provider: "claude" });
    assert.match(text, /policy\s+static-only/);
    assert.match(text, /not reachable:[\s\S]*source index \(490 chunks/);
    assert.ok(!/reachable by the provider:[\s\S]*cached source chunks/.test(text),
      "cached chunks must not be listed as reachable under static-only");
  });

  test("cached-source lists the chunks as reachable", () => {
    const exposure = describeExposure(fakeStore(true, 0));
    assert.equal(exposure.exposure, "cached-source");
    assert.equal(exposure.withheldChars, 0);
    assert.match(renderDisclosure(exposure, { provider: "codex" }), /policy\s+cached-source/);
  });

  test("excerpt volume is counted, since that is the source that leaves", () => {
    const exposure = describeExposure(fakeStore(false, 1));
    assert.equal(exposure.excerpts, 2);
    assert.equal(exposure.excerptChars, 150);
    assert.equal(exposure.redactedRecords, 1);
    assert.match(renderDisclosure(exposure, { provider: "claude" }), /2 evidence excerpts/);
  });

  test("the actual-access report distinguishes silence from zero", () => {
    assert.match(renderActualAccess(null), /no log written/);
    assert.match(
      renderActualAccess({ calls: 3, denied: 1, accessLog: [
        { name: "search_facts" }, { name: "search_facts" }, { name: "get_records" }] }),
      /3 calls, 1 denied[\s\S]*search_facts×2, get_records/);
  });

  test("the adapter launches the server with the exposure it was given", async () => {
    const provider = new ClaudeCliProvider({ binary: path.join(bin, "claude-ok") });
    await provider.analyzeSlice(request({ sourceExposure: "static-only" }));
    const argv = argvOf("claude-ok");
    const config = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8"));
    const serverArgs = config.mcpServers.contextkit.args;
    assert.equal(serverArgs[serverArgs.indexOf("--source-exposure") + 1], "static-only",
      "the disclosure describes this setting; the server must actually receive it");
  });
});

describe("results come back in one shape", () => {
  test("claude's envelope is unwrapped to the structured answer", async () => {
    const provider = new ClaudeCliProvider({ binary: path.join(bin, "claude-ok") });
    const outcome = await provider.analyzeSlice(request());
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.result, ANSWER);
    assert.equal(outcome.provider, "claude");
    assert.equal(outcome.model, "fake-model");
    assert.equal(outcome.usage.output_tokens, 20);
    assert.ok(outcome.durationMs >= 0);
  });

  test("codex's fenced last message is unwrapped the same way", async () => {
    const provider = new CodexCliProvider({ binary: path.join(bin, "codex-ok") });
    const outcome = await provider.analyzeSlice(request());
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.result, ANSWER);
    assert.equal(outcome.provider, "codex");
  });

  test("both write a transcript that records the exact argv", async () => {
    for (const provider of [
      new ClaudeCliProvider({ binary: path.join(bin, "claude-ok") }),
      new CodexCliProvider({ binary: path.join(bin, "codex-ok") }),
    ]) {
      const outcome = await provider.analyzeSlice(request());
      const transcript = JSON.parse(fs.readFileSync(outcome.transcriptPath, "utf8"));
      assert.ok(Array.isArray(transcript.args) && transcript.args.length > 0);
      assert.equal(transcript.status, 0);
    }
  });
});

describe("failures are reported, never silently swallowed", () => {
  for (const [label, Provider] of [["claude", ClaudeCliProvider], ["codex", CodexCliProvider]]) {
    test(`${label}: a non-zero exit raises with the provider's stderr`, async () => {
      const provider = new Provider({ binary: path.join(bin, "cli-fails") });
      await assert.rejects(
        () => provider.analyzeSlice(request()),
        (error) => {
          assert.ok(error instanceof ProviderError);
          assert.equal(error.provider, label);
          assert.match(error.stderr, /authentication required/);
          return true;
        });
    });

    test(`${label}: a hang is killed and reported as a timeout`, async () => {
      const provider = new Provider({ binary: path.join(bin, "cli-hangs"), timeoutMs: 800 });
      await assert.rejects(
        () => provider.analyzeSlice(request()),
        (error) => {
          assert.match(error.message, /timed out/);
          return true;
        });
    });

    test(`${label}: unparseable output is a failed result, not a crash`, async () => {
      const provider = new Provider({ binary: path.join(bin, "cli-garbage") });
      const outcome = await provider.analyzeSlice(request());
      assert.equal(outcome.ok, false, "prose with no JSON must not be reported as success");
      assert.equal(outcome.result, null);
      assert.ok(outcome.transcriptPath, "the transcript still records what happened");
    });
  }

  test("a missing binary reports unavailable rather than throwing", async () => {
    const provider = new ClaudeCliProvider({ binary: path.join(bin, "does-not-exist") });
    assert.equal(await provider.available(), null);
  });

  test("a present binary reports its version", async () => {
    const provider = new ClaudeCliProvider({ binary: path.join(bin, "claude-ok") });
    assert.match(await provider.available(), /9\.9\.9/);
  });
});

describe("response parsing", () => {
  test("accepts bare, fenced, and embedded JSON", () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extractJson('Sure, here it is:\n{"a":1}\nHope that helps.'), { a: 1 });
    assert.deepEqual(extractJson("[1,2,3]"), [1, 2, 3]);
  });

  test("is not fooled by a brace inside a string", () => {
    // Naive brace counting truncates here, producing invalid JSON or a partial object.
    assert.deepEqual(extractJson('{"note":"a } brace","ok":true}'), { note: "a } brace", ok: true });
    assert.deepEqual(extractJson('{"note":"say \\"hi\\" }","ok":1}'), { note: 'say "hi" }', ok: 1 });
  });

  test("returns null rather than guessing", () => {
    assert.equal(extractJson("I could not complete that."), null);
    assert.equal(extractJson(""), null);
    assert.equal(extractJson(null), null);
    assert.equal(extractJson("{ unterminated"), null);
  });
});

describe("access log", () => {
  test("prefers the per-call jsonl over the exit-time summary", () => {
    // The summary is missing whenever the provider kills the server, so trusting it
    // would report "no calls" for a session that made plenty.
    const base = path.join(workRoot, "log.json");
    fs.writeFileSync(`${base}l`, [
      JSON.stringify({ outcome: "allowed", name: "search_facts", kind: "tool" }),
      JSON.stringify({ outcome: "denied", name: "find_chunks", kind: "tool",
        detail: "host-path-rejected: nope" }),
    ].join("\n") + "\n");
    fs.writeFileSync(base, JSON.stringify({ calls: 0, denied: 0, accessLog: [] }));

    const report = readAccessLog(base);
    assert.equal(report.calls, 2);
    assert.equal(report.denied, 1);
    assert.equal(report.deniedByCode["host-path-rejected"], 1);
  });

  test("falls back to the summary, and to null when neither exists", () => {
    const only = path.join(workRoot, "summary-only.json");
    fs.writeFileSync(only, JSON.stringify({ calls: 7, denied: 1 }));
    assert.equal(readAccessLog(only).calls, 7);
    assert.equal(readAccessLog(path.join(workRoot, "absent.json")), null);
  });
});

describe("process handling", () => {
  test("a timeout kills the whole process group, not just the leader", async () => {
    // A provider CLI spawns the MCP server as a child; killing only the leader leaves
    // that child alive holding the pipe.
    const marker = path.join(workRoot, "orphan.txt");
    const script = fakeCli("spawns-child", `
      const { spawn } = require("node:child_process");
      const child = "const f = process.argv[1];"
        + "setInterval(() => require('node:fs').appendFileSync(f, 'x'), 50);";
      spawn(process.execPath, ["-e", child, process.argv[2]], { stdio: "ignore" });
      setTimeout(() => {}, 60000);
    `);
    const outcome = await run(process.execPath, [script, marker], { timeoutMs: 700 });
    assert.equal(outcome.timedOut, true, "the fake must actually hang for this test to mean anything");
    assert.ok(fs.existsSync(marker), "the child must have started, or nothing is being proven");

    const sizeAfterKill = fs.existsSync(marker) ? fs.statSync(marker).size : 0;
    await new Promise((r) => setTimeout(r, 400));
    const sizeLater = fs.existsSync(marker) ? fs.statSync(marker).size : 0;
    assert.equal(sizeLater, sizeAfterKill, "a child kept writing after the timeout");
  });

  test("a missing binary resolves rather than throwing", async () => {
    const outcome = await run(path.join(bin, "nope"), [], { timeoutMs: 2000 });
    assert.equal(outcome.ok, false);
    assert.ok(outcome.spawnError);
  });
});
