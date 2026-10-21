---
name: repo-network
description: Build NETWORK_FACTS.json, the component network that ContextKit's /network explorer draws, by running a ContextKit checkout's scanner on a repository and optionally adding semantic analysis. Use when asked for a component network, network graph, or orb view of a repository, or for NETWORK_FACTS.json. Not for REPO_GRAPH.json, which the repo-graph skill writes.
---

# Repo Network

`NETWORK_FACTS.json` is built from ContextKit's static scan, so it always comes from ContextKit's commands, never from hand-written JSON. Run them through [scripts/contextkit](scripts/contextkit), which finds the ContextKit checkout this skill belongs to, or the one in `$CONTEXTKIT_HOME`:

```bash
<skill-dir>/scripts/contextkit network <repo> --output <file>
```

## Ground rules

- The target repository is read-only. Don't create, edit, or delete files in it, and don't run its code.
- Write the export outside the target repository: to the path the user names, otherwise `~/context-packs/<repo-name>/NETWORK_FACTS.json`. Run artifacts land beside it in `.contextkit/work/`. They contain source excerpts, so keep them out of anything shared or committed.
- If the export already exists, ask before replacing it unless the user asked to regenerate it.
- Analyze private repositories from a local checkout. Remote sources must be public clone URLs.
- If the script reports missing dependencies, tell the user, and run the install command it prints only with their go-ahead.

## Modes

| Mode | Use when | How |
|---|---|---|
| Static (default) | The user wants the network and didn't ask for architecture | `scripts/contextkit network <repo> --output <file>` |
| Semantic, by you | The user wants named components, external systems, stores, and flows | Follow [references/semantic-analysis.md](references/semantic-analysis.md) |
| Semantic, headless | The user asks for Claude Code or Codex to run it unattended | `scripts/contextkit network <repo> --provider claude --output <file>`, or `codex` |

Static mode needs no model and usually finishes in seconds. Its components are directory groups and its call graph is partial; the command prints both caveats. Headless mode starts a separate agent for each slice and can take many minutes per slice, so say so before starting. If Codex rejects its default model, pass `--model`.

## Report back

Give the output path, the counts and warnings the command printed, and the run directory, which is needed to resume or re-export. The file loads at `/network` in the ContextKit explorer (`make web-dev` in the checkout).
