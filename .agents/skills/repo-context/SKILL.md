---
name: repo-context
description: Write evidence-grounded documents that explain a repository to one kind of reader (overview, architecture, module guide, PR reviewer guide, contributor guide, AI-agent context, or interview brief) and save them outside the repository. Use when asked to document, explain, or onboard someone to a codebase, or to generate a ContextKit context pack. Not for editing a repository's existing docs.
---

# Repo Context

Explain a repository to a specific reader, using only what its files show.

## Ground rules

- The target repository is read-only. Don't create, edit, or delete files in it, and don't run its code: no tests, builds, installs, or scripts. Reading, searching, and `git log` are enough.
- Save documents outside the target repository: in the directory the user names, otherwise `~/context-packs/<repo-name>/`. Write inside the repository only when the user explicitly asks. If your sandbox blocks the location, ask for approval or another directory; don't fall back to the repository.
- Don't overwrite an existing document unless the user asks to regenerate it.
- Read [references/standards.md](references/standards.md) before writing. It defines how claims are grounded and how the documents read.

## Audiences

| Audience | File | Guide | Reader |
|---|---|---|---|
| `human` (default) | `HUMAN_OVERVIEW.md` | [human.md](references/human.md) | Someone who wants the gist without reading the code |
| `architecture` | `ARCHITECTURE.md` | [architecture.md](references/architecture.md) | A maintainer reasoning about design and boundaries |
| `modules` | `MODULE_GUIDE.md` | [modules.md](references/modules.md) | A developer looking for where things live |
| `reviewer` | `REVIEWER_GUIDE.md` | [reviewer.md](references/reviewer.md) | Someone reviewing a pull request |
| `contributor` | `CONTRIBUTOR_GUIDE.md` | [contributor.md](references/contributor.md) | A newcomer making a first change |
| `agent` | `AGENT_CONTEXT.md` | [agent.md](references/agent.md) | An AI coding or review agent |
| `interviewer` | `INTERVIEWER_BRIEF.md` | [interviewer.md](references/interviewer.md) | A developer explaining the project in an interview |

"All" or "a context pack" means every audience. Read only the guides for the documents you are writing.

## Workflow

1. **Resolve the target.** Use the path the user gives, or the current repository. For a public Git URL, shallow-clone it into a new temporary directory (`git clone --depth 1 <url> <dir>`) and delete the clone when you finish, unless the user wants to keep it.
2. **Inspect once.** Follow the inspection order in the standards. For several documents, reuse what you found instead of re-reading the repository for each one.
3. **Write each document** with exactly the headings its guide lists, in order. If the user describes the reader further (a beginner, a security reviewer), adjust depth and vocabulary inside that structure.
4. **Index a pack.** When the output directory holds more than one document, write or update `INDEX.md`: the source, its Git revision (`git rev-parse --short HEAD`), and a link to each document, plus `REPO_GRAPH.json` if present.
5. **Report back** with the output paths and the open questions a reader should know about.

For a machine-readable architecture graph, use the `repo-graph` skill.
