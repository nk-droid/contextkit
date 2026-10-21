import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function graphDocument() {
  return {
    schemaVersion: 1,
    repository: {
      id: "sample-repository",
      name: "Sample repository",
      source: "synthetic CLI test",
    },
    graphs: [
      {
        id: "architecture",
        kind: "architecture",
        title: "Architecture",
        description: "A synthetic CLI integration test graph.",
        nodes: [
          {
            id: "command",
            label: "Command",
            kind: "entrypoint",
            path: "bin/tool",
            summary: "Runs the synthetic tool.",
            basis: "observed",
            evidence: [{ path: "bin/tool", detail: "Synthetic entrypoint." }],
          },
        ],
        edges: [],
      },
    ],
    warnings: [],
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "contextkit-cli-test-"));
  const repository = join(root, "sample-repository");
  const output = join(root, "output");
  const fakeBin = join(root, "fake-bin");
  mkdirSync(join(repository, "bin"), { recursive: true });
  mkdirSync(output);
  mkdirSync(fakeBin);
  writeFileSync(join(repository, "bin", "tool"), "#!/bin/sh\n");
  writeFileSync(join(output, "HUMAN_OVERVIEW.md"), "# Existing overview\n");

  const fakeCodex = join(fakeBin, "codex");
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output-last-message" ]]; then
    output="$2"
    shift 2
  else
    shift
  fi
done
cp "$FAKE_GRAPH" "$output"
`,
  );
  chmodSync(fakeCodex, 0o755);

  const fakeClaude = join(fakeBin, "claude");
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bash
has_json_schema="false"
for argument in "$@"; do
  if [[ "$argument" == "--json-schema" ]]; then
    has_json_schema="true"
  fi
done
if [[ "\${REQUIRE_JSON_SCHEMA:-0}" == "1" && "$has_json_schema" != "true" ]]; then
  printf '%s\n' "missing --json-schema" >&2
  exit 9
fi
printf '%s\n' "\${FAKE_CLAUDE_OUTPUT:-synthetic claude output}"
printf '%s\n' "\${FAKE_CLAUDE_ERROR:-}" >&2
exit "\${FAKE_CLAUDE_STATUS:-0}"
`,
  );
  chmodSync(fakeClaude, 0o755);

  return { root, repository, output, fakeBin };
}

function runContextKit(setup, graphPath, extraArgs = [], environment = {}) {
  return spawnSync(
    join(projectRoot, "bin", "contextkit"),
    [
      "generate",
      setup.repository,
      "--with-graph",
      "--output",
      setup.output,
      ...extraArgs,
    ],
    {
      cwd: setup.root,
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GRAPH: graphPath,
        PATH: `${setup.fakeBin}:${process.env.PATH ?? ""}`,
        ...environment,
      },
    },
  );
}

test("--with-graph validates and publishes agent output", () => {
  const setup = fixture();
  try {
    const source = join(setup.root, "valid.json");
    writeFileSync(source, JSON.stringify(graphDocument()));
    const result = runContextKit(setup, source);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(join(setup.output, "REPO_GRAPH.json"), "utf8")),
      graphDocument(),
    );
    assert.match(readFileSync(join(setup.output, "INDEX.md"), "utf8"), /REPO_GRAPH\.json/);
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});

test("invalid regeneration preserves the previous graph", () => {
  const setup = fixture();
  try {
    const source = join(setup.root, "invalid.json");
    const existing = "{\"previous\":true}\n";
    writeFileSync(source, "not JSON\n");
    writeFileSync(join(setup.output, "REPO_GRAPH.json"), existing);
    const result = runContextKit(setup, source, ["--regenerate"]);
    assert.notEqual(result.status, 0);
    assert.equal(
      readFileSync(join(setup.output, "REPO_GRAPH.json"), "utf8"),
      existing,
    );
    assert.match(result.stderr, /existing REPO_GRAPH\.json was preserved/);
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});

test("Claude failures surface both stdout and stderr", () => {
  const setup = fixture();
  try {
    const source = join(setup.root, "unused.json");
    writeFileSync(source, JSON.stringify(graphDocument()));
    const result = runContextKit(
      setup,
      source,
      ["--agent", "claude"],
      {
        FAKE_CLAUDE_OUTPUT: "simulated stdout failure",
        FAKE_CLAUDE_ERROR: "simulated stderr failure",
        FAKE_CLAUDE_STATUS: "7",
      },
    );
    assert.equal(result.status, 7);
    assert.match(result.stderr, /claude generation failed.*exit 7/);
    assert.match(result.stderr, /simulated stdout failure/);
    assert.match(result.stderr, /simulated stderr failure/);
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});

test("generate sends the skills' standards, guides, and graph rules to the agent", () => {
  const root = mkdtempSync(join(tmpdir(), "contextkit-cli-prompts-"));
  try {
    const repository = join(root, "sample-repository");
    const prompts = join(root, "prompts");
    const fakeBin = join(root, "fake-bin");
    mkdirSync(join(repository, "bin"), { recursive: true });
    mkdirSync(prompts);
    mkdirSync(fakeBin);
    writeFileSync(join(repository, "bin", "tool"), "#!/bin/sh\n");
    writeFileSync(join(root, "graph.json"), JSON.stringify(graphDocument()));
    // Saves each prompt under the name of the file the CLI asked for.
    writeFileSync(
      join(fakeBin, "codex"),
      `#!/usr/bin/env bash
set -euo pipefail
output=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "--output-last-message" ]]; then output="$2"; shift 2; else shift; fi
done
name="$(basename "$output")"
cat > "$PROMPTS/\${name%%.tmp.*}"
if [[ "$name" == .REPO_GRAPH.json.* ]]; then cp "$FAKE_GRAPH" "$output"; else echo "# Document" > "$output"; fi
`,
    );
    chmodSync(join(fakeBin, "codex"), 0o755);

    const result = spawnSync(
      join(projectRoot, "bin", "contextkit"),
      ["generate", repository, "--all", "--with-graph", "--output", join(root, "output")],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PROMPTS: prompts,
          FAKE_GRAPH: join(root, "graph.json"),
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);

    const skills = join(projectRoot, ".agents", "skills");
    const read = (...parts) => readFileSync(join(...parts), "utf8").trimEnd();
    const standards = read(skills, "repo-context", "references", "standards.md");
    const documents = {
      human: "HUMAN_OVERVIEW.md",
      architecture: "ARCHITECTURE.md",
      modules: "MODULE_GUIDE.md",
      reviewer: "REVIEWER_GUIDE.md",
      contributor: "CONTRIBUTOR_GUIDE.md",
      agent: "AGENT_CONTEXT.md",
      interviewer: "INTERVIEWER_BRIEF.md",
    };
    for (const [audience, file] of Object.entries(documents)) {
      const prompt = read(prompts, file);
      assert.ok(prompt.includes(standards), `${file} prompt lacks the standards`);
      assert.ok(
        prompt.includes(read(skills, "repo-context", "references", `${audience}.md`)),
        `${file} prompt lacks its audience guide`,
      );
    }
    assert.ok(
      read(prompts, ".REPO_GRAPH.json").includes(read(skills, "repo-graph", "references", "graph-rules.md")),
      "graph prompt lacks the graph rules",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude graph generation requests schema-constrained output", () => {
  const setup = fixture();
  try {
    const source = join(setup.root, "unused.json");
    writeFileSync(source, JSON.stringify(graphDocument()));
    const result = runContextKit(
      setup,
      source,
      ["--agent", "claude"],
      {
        FAKE_CLAUDE_OUTPUT: JSON.stringify(graphDocument()),
        REQUIRE_JSON_SCHEMA: "1",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(join(setup.output, "REPO_GRAPH.json"), "utf8")),
      graphDocument(),
    );
  } finally {
    rmSync(setup.root, { recursive: true, force: true });
  }
});
