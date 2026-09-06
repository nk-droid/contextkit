# ContextKit

Generate evidence-backed repository context packs and interactive architecture graphs for humans and AI agents.

![ContextKit demo](docs/assets/contextkit-demo.gif)

## Why ContextKit?

Understanding an unfamiliar repository means piecing together information from source files, tests, configuration, scripts, CI workflows, and documentation. ContextKit turns that scattered knowledge into a structured context pack for onboarding, review, contribution, interview preparation, and AI-assisted development.

Unlike a generic repository summary, ContextKit produces audience-specific documents and a validated graph whose observed architecture claims cite repository-relative evidence paths.

## Architecture

```mermaid
graph LR
    source[GitHub URL or local repository] --> cli[ContextKit CLI]
    cli --> agent[Codex or Claude Code]
    agent --> documents[Audience-specific Markdown]
    agent --> candidate[Candidate repository graph]
    candidate --> validator[Schema and evidence validator]
    validator --> graphfile[Validated repository graph]
    graphfile --> ui[React interface]
    ui --> renderer[React Flow and Dagre]
    ui --> api[Repository API]
    api --> database[SQLite or Cloudflare D1]
    database --> api
```

The Bash CLI handles source resolution, temporary cloning, agent invocation, output selection, and atomic file publishing. Codex or Claude Code inspects the target repository in read-only mode. The optional React application validates and stores imported graph documents before rendering them with React Flow and Dagre.

## Quick Start

Requirements:

- Git and a Bash-compatible shell
- Codex CLI installed and authenticated, or Claude Code
- Node.js `>=22.13.0` for graph validation and the web interface

Install the CLI:

```bash
git clone https://github.com/nk-droid/contextkit.git
cd contextkit
make install
export PATH="$PWD/bin:$PATH"
```

Generate a complete context pack:

```bash
contextkit generate https://github.com/owner/repository --all --with-graph
```

Start the graph explorer:

```bash
make web-install
make web-dev
```

Open the local URL printed by the development server and import the generated `REPO_GRAPH.json` file.

## Example

Generate all documents and a repository graph with Codex:

```bash
contextkit generate https://github.com/owner/repository \
  --all \
  --with-graph
```

Use Claude Code with a larger turn budget:

```bash
contextkit generate /path/to/local/repository \
  --all \
  --with-graph \
  --agent claude \
  --max-turns 30
```

Choose a separate output directory:

```bash
contextkit generate /path/to/local/repository \
  --all \
  --with-graph \
  --output /path/to/output
```

Existing files are skipped by default. Add `--regenerate` to replace the selected outputs.

## Generated Context

| Audience | Output | Focus |
|---|---|---|
| Human | `HUMAN_OVERVIEW.md` | Plain-English repository orientation |
| Architecture | `ARCHITECTURE.md` | Components, boundaries, flows, and trade-offs |
| Modules | `MODULE_GUIDE.md` | Important directories, files, and responsibilities |
| Reviewer | `REVIEWER_GUIDE.md` | Risk areas, checks, and validation strategy |
| Contributor | `CONTRIBUTOR_GUIDE.md` | Setup, reading order, and common workflows |
| Agent | `AGENT_CONTEXT.md` | Concise constraints and paths for AI systems |
| Interviewer | `INTERVIEWER_BRIEF.md` | Project narrative, decisions, and talking points |

A complete generation produces:

```text
context-packs/
  repository-name/
    INDEX.md
    HUMAN_OVERVIEW.md
    ARCHITECTURE.md
    MODULE_GUIDE.md
    REVIEWER_GUIDE.md
    CONTRIBUTOR_GUIDE.md
    AGENT_CONTEXT.md
    INTERVIEWER_BRIEF.md
    REPO_GRAPH.json
```

Generate one audience instead of the complete pack with `--audience human`, `architecture`, `modules`, `reviewer`, `contributor`, `agent`, or `interviewer`.

## Repository Graph

`--with-graph` generates a portable `REPO_GRAPH.json` document conforming to the versioned contract in `schemas/repo-graph.schema.json`.

The graph can contain architecture, runtime-flow, import, and deployment views. Nodes and edges distinguish directly observed behavior from inferred relationships. Every observed graph element must include at least one valid repository-relative evidence path.

Validate a graph without opening the UI:

```bash
node scripts/validate-graph.mjs \
  path/to/REPO_GRAPH.json \
  /path/to/repository
```

The React explorer supports:

- multiple repositories and graph views
- searchable nodes and paths
- node-kind and edge-kind filters
- inferred-relationship toggles
- evidence inspection
- automatic horizontal and vertical layouts
- JSON file and directory imports

Imported graph documents and repository metadata are persisted in SQLite through a `DB` binding. Local development stores the database under `web/.wrangler/state/`; hosted deployments use Cloudflare D1. No repository is seeded.

## Safety Model

- ContextKit does not need to be installed inside the target repository.
- Public GitHub repositories are cloned into a temporary workspace.
- Local repositories are inspected in place without writing to them.
- Agent tools are restricted to repository reading and searching.
- Generated context is written outside the target repository by default.
- Graph output is written to a temporary file and validated before an atomic replacement.
- Invalid regeneration preserves the previous valid graph.
- Evidence paths must remain inside the repository and exist at validation time.

Generated context is still a starting point for investigation, not a replacement for code review.

## Evaluation

ContextKit currently uses deterministic tests for the behavior it can verify automatically:

- schema conversion for Claude Code structured output
- successful graph generation and publication
- preservation of an existing graph after invalid regeneration
- surfaced agent error output
- structural graph validation
- unsafe and missing evidence-path rejection
- dangling-edge rejection
- observed-evidence enforcement
- duplicate-identifier rejection

Run the nine automated CLI and graph checks:

```bash
make graph-test
```

Validate the web application:

```bash
make web-build
```

Repository-scale evaluation should additionally record the pinned commit, source lines, tracked files, generation time, output size, graph nodes and edges, evidence references, unique evidence paths, and a manually audited evidence-accuracy sample. Performance numbers should only be published from repeatable measured runs.

## Architecture Decisions

- **Thin Bash orchestration:** keeps the CLI focused on source handling and agent execution rather than duplicating repository-analysis logic.
- **Audience-specific documents:** produces focused context instead of one long summary that serves every reader poorly.
- **External output:** avoids modifying repositories that a user only wants to understand.
- **Versioned graph contract:** keeps generated JSON portable and independent from the renderer.
- **Observed versus inferred relationships:** makes uncertainty visible instead of presenting every model conclusion as fact.
- **Evidence-required graph elements:** connects architectural claims to files that a reviewer can inspect.
- **Atomic graph generation:** prevents malformed model output from replacing the last valid artifact.
- **SQLite-compatible persistence:** uses local SQLite during development and Cloudflare D1 when hosted.
- **Computed layouts:** stores repository meaning rather than UI coordinates, allowing the frontend to change layout direction and spacing.

## Limitations

- Repository understanding depends on what the selected agent discovers within its inspection budget.
- Very large repositories may require narrower runs or a larger Claude Code turn limit.
- ContextKit does not currently record the exact files opened by the generation agent.
- Markdown claims are not yet represented as individually machine-verifiable evidence records.
- The MVP does not perform a separate static-analysis pass beyond agent inspection and graph validation.
- Generated context can become stale after the source repository changes.
- The web interface has no application-level authentication and should not be exposed publicly with private graph data.
- Codex or Claude Code must be installed and authenticated separately.

## Roadmap

- Publish reproducible benchmarks across repository sizes and languages.
- Add revision-aware stale-context detection and incremental regeneration.
- Record inspection telemetry and claim-level evidence coverage.
- Add optimized profiles for major frameworks and monorepos.
