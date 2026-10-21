# ContextKit Project Instructions

ContextKit is a local-first repository understanding kit. It generates readable context packs for public GitHub repos and locally cloned private repos without copying ContextKit into the target repository.

## Product Rules

- Keep ContextKit separate from the target repo.
- Do not require users to commit ContextKit files into repositories they analyze.
- Default behavior must be read-only for target repositories.
- Generated output should go into `context-packs/<repo-name>/` or a user-provided output directory.
- Prefer human-friendly explanation over raw file dumps.
- Every generated claim should be grounded in visible repository files or clearly marked as an inference.

## Tone

Write like a senior engineer onboarding another engineer:

- clear
- practical
- direct
- no hype
- no vague claims
- no exaggerated architecture assumptions

## Development Rules

- Keep the MVP small.
- Avoid adding heavy dependencies.
- Prefer Bash and Markdown unless a real CLI framework becomes necessary.
- If adding code, include usage examples and failure modes.
- Never suggest writing into the target repo by default.

## Where Things Live

- `bin/` - CLIs. `contextkit` (`generate`, `network`) is the entry point; the others are pipeline stages and inspection tools.
- `.agents/skills/` - agent skills, and the only home of the document and graph prompt text. `bin/contextkit` reads it; `.claude/skills/` links to it for Claude Code.
- `src/analysis/` - static scanner, extractors, MCP server, provider adapters, and semantic slices.
- `prompts/analysis/` - prompts for the semantic slices in the network pipeline.
- `src/network/` - assembles and validates `NETWORK_FACTS.json`.
- `schemas/` - JSON contracts. `scripts/` - schema converters and the graph validator.
- `web/` - graph and network explorer.
- `tests/` - `node --test` suites and fixture repositories.

## Skills

- `repo-context` writes the audience documents, `repo-graph` writes `REPO_GRAPH.json`, and `repo-network` drives the network pipeline for `NETWORK_FACTS.json`. All three are meant for use on other repositories, so `make install-skills` links them into user-level skill directories.
- `repo-network` carries no copy of the pipeline: its `scripts/contextkit` runs this checkout's `bin/` commands. Its agent mode is `contextkit-analyze --provider agent` (`--prepare`, then `--result`) with tool calls through `contextkit-mcp ... --provider agent --slice <id>`; the agent's prompt addendum is `prompts/analysis/agent-mode.md`, and the provider is `src/analysis/providers/agent.mjs`.
- Edit skills under `.agents/skills/<name>/`. The `.claude/skills/` entries are symlinks.
- Changing `repo-context/references/` or `repo-graph/references/graph-rules.md` also changes what `contextkit generate` sends to agents.
- `repo-graph` bundles copies of `scripts/validate-graph.mjs` and `schemas/repo-graph.schema.json` so it works outside this checkout. After changing either original, run `make sync-skills`; `make test` fails while they differ.

## Context Document Standards

Generated documents follow `.agents/skills/repo-context/references/standards.md` and the audience guides beside it.

## Key Commands

```bash
make test
bin/contextkit generate https://github.com/owner/repo --audience human
bin/contextkit generate ~/work/private-repo --all
bin/contextkit generate ~/work/private-repo --all --with-graph
bin/contextkit generate ~/work/private-repo --audience reviewer --output ./context-packs/private-repo
bin/contextkit network ~/work/private-repo
make scan REPO=~/work/private-repo
make web-dev
make install-skills
```
