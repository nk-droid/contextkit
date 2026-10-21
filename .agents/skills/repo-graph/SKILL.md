---
name: repo-graph
description: Build a validated REPO_GRAPH.json for a repository, with architecture, runtime-flow, import, or deployment views whose nodes and edges cite repository files or are marked inferred. Use when asked for a repository or architecture graph in ContextKit's format, or for a file to load into the ContextKit explorer. Not for Mermaid or other diagram formats.
---

# Repo Graph

Produce a `REPO_GRAPH.json` that passes the bundled validator, without touching the target repository.

## Ground rules

- The target repository is read-only. Don't create, edit, or delete files in it, and don't run its code.
- Write the graph outside the target repository: in the directory the user names, otherwise `~/context-packs/<repo-name>/`. If your sandbox blocks the location, ask for approval or another directory; don't fall back to the repository.
- Don't overwrite an existing `REPO_GRAPH.json` unless the user asks to regenerate it, and never with a graph that failed validation.

## Workflow

1. **Resolve the target.** Use the path the user gives, or the current repository. For a public Git URL, shallow-clone it into a new temporary directory (`git clone --depth 1 <url> <dir>`) and delete the clone when you finish, unless the user wants to keep it.
2. **Read [references/graph-rules.md](references/graph-rules.md).** It defines the document shape and what belongs in each view.
3. **Inspect the repository**: README, manifests, entry points, then the main source directories. Note the evidence path for each node and edge as you go.
4. **Write the JSON to a temporary file** in the output directory, such as `.REPO_GRAPH.json.tmp`.
5. **Validate it** against the repository with the script in this skill's directory:

   ```bash
   node <skill-dir>/scripts/validate-graph.mjs <temp-file> <repository-root>
   ```

   It prints `Valid repository graph` and exits 0, or lists each problem (unsafe or missing path, missing evidence, dangling edge, duplicate id) and exits 1. Fix the problems and run it again. If Node.js isn't available, check the rules by hand and tell the user the graph wasn't machine-validated.
6. **Publish** by renaming the temporary file to `REPO_GRAPH.json`. If the directory has an `INDEX.md`, link the graph from it.
7. **Report back** with the output path, the views you included, and what you marked inferred or left out.

The graph loads in the ContextKit explorer: run `make web-dev` in a ContextKit checkout and import the file.
