# ContextKit Design

## Goal

ContextKit helps people and AI systems understand unfamiliar repositories quickly.

It is intentionally not a code generator and not a replacement for engineering review. It is a context generator.

## Inputs

ContextKit accepts:

1. Public GitHub repository URLs.
2. Local paths to already cloned repositories.

## Outputs

ContextKit writes Markdown context packs and, when requested, a machine-readable repository graph outside the target repository.

Default:

```text
./context-packs/<repo-name>/
```

Custom:

```bash
contextkit generate ~/work/repo --all --output ~/Desktop/repo-context
```

## Why output is external

External output keeps the target repository clean and avoids implying that every project should commit ContextKit files.

This is especially important for private repositories and open-source repos that the user is only reviewing.

## Why the MVP uses Bash

The MVP needs only a thin runner:

- parse source and options
- clone public repos
- resolve local paths
- call the selected agent CLI
- save markdown output

The intelligence belongs in prompts, skills, agents, and templates.

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

The `web/` application renders graph artifacts with React Flow and Dagre. It deliberately separates the portable graph document from its computed viewport layout, so imported data stays renderer-independent.

Repository metadata and complete graph documents are persisted in SQLite through a `DB` binding. The binding is Cloudflare D1 when hosted and a local SQLite-backed D1 database during development. The API validates every imported document before an upsert. There is no seed path: a new database is empty until a user imports a graph.

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
- The MVP does not perform static analysis outside the selected agent's repository inspection.

## Future improvements

- Stale-context detection.
- Better monorepo support.
- Config file for custom audience templates.
- Batch mode for multiple repositories.
