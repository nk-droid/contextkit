# ContextKit Design

## Goal

ContextKit helps people and AI systems understand unfamiliar repositories quickly.

It is intentionally not a code generator and not a replacement for engineering review. It is a context generator.

## Inputs

ContextKit accepts:

1. Public GitHub repository URLs.
2. Local paths to already cloned repositories.
3. For the network pipeline, run directories from an earlier scan, to resume without rescanning.

## Outputs

ContextKit writes Markdown context packs, an optional machine-readable repository graph (`REPO_GRAPH.json`), and a component network (`NETWORK_FACTS.json`), all outside the target repository.

Default for context packs:

```text
./context-packs/<repo-name>/
```

The network pipeline defaults to ContextKit's own `context-packs/<name>-<source-id>/`.

Custom:

```bash
contextkit generate ~/work/repo --all --output ~/Desktop/repo-context
```

## Why output is external

External output keeps the target repository clean and avoids implying that every project should commit ContextKit files.

This is especially important for private repositories and open-source repos that the user is only reviewing.

## Why the document CLI is Bash

Document generation needs only a thin runner:

- parse source and options
- clone public repos
- resolve local paths
- call the selected agent CLI
- save markdown output

The intelligence belongs in the agent skills under `.agents/skills/`. The CLI feeds their audience guides and graph rules to headless agents, and interactive agents load the same skills directly.

The network pipeline is Node.js instead, because deterministic scanning, validation, and assembly need real code; `bin/contextkit network` only dispatches to it.

## Network pipeline

The component network trades the agent's free inspection for a fixed set of measured facts. The full behavior is in [network.md](network.md).

- The static scanner is the only stage that reads the target repository. It freezes what it finds into a run: `STATIC_ANALYSIS.json` plus a private source index, kept outside the target.
- Headless providers run in an empty directory and reach the run only through the MCP access layer, which serves static facts by default and logs every call.
- Semantic slices run in dependency order. The foundation slice freezes component and external-system ids, and later slices may only reference them.
- Every slice result is validated before use: evidence ids must come from the run, and scanner-measured values cannot be rewritten. Invalid results are kept for diagnosis.
- The agent provider (the `repo-network` skill) goes through the same validation but cannot be confined, because ContextKit does not launch it.

## Repository graph contract

`--with-graph` asks the selected agent for `REPO_GRAPH.json`. The versioned contract lives at `schemas/repo-graph.schema.json` and models multiple views of a repository as typed nodes, directed edges, and repository-relative evidence.

The CLI applies semantic validation in addition to the JSON contract:

- graph, node, and edge identifiers must be unique in their scopes
- edge endpoints must exist
- observed nodes and edges must cite evidence
- evidence paths must be safe and must exist when the source repository is available
- graph size is bounded for browser rendering

Generation uses a temporary file and an atomic rename, so malformed model output cannot overwrite the last valid graph.

## React explorer and storage

The `web/` application renders graph artifacts with React Flow and Dagre, and draws network facts as an orb at `/network`. It deliberately separates the portable documents from their computed layout, so imported data stays renderer-independent.

Repository metadata, complete graph documents, and network facts are persisted in SQLite through a `DB` binding. The binding is Cloudflare D1 when hosted and a local SQLite-backed D1 database during development. The API validates every imported document before an upsert. There is no seed path: a new database is empty until a user imports a graph.

## Read-only default

The CLI calls the selected agent in non-interactive mode and captures stdout to files. Codex is the default agent; Claude Code can be selected with `--agent claude`.

This supports repo analysis without modifying the target.

## Audience model

The same repository can be explained differently depending on the audience:

- humans need clarity and reading order
- maintainers need architecture and operational notes
- reviewers need risk and validation guidance
- contributors need setup and safe first changes
- AI agents need compact structured constraints
- interviewees need talking points and trade-offs

## Limitations

- Generated context can be incomplete if the repository is very large.
- The selected agent may miss important implicit behavior.
- Some commands may not be discoverable from repo files.
- Private repo analysis depends on local agent access.
- Document generation relies on the agent's own inspection; only the network pipeline uses the deterministic scanner.

## Future improvements

- Stale-context detection.
- Better monorepo support.
- Config file for custom audience guides.
- Batch mode for multiple repositories.
