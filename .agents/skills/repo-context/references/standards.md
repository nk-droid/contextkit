# ContextKit document standards

These apply to every ContextKit document, whatever the audience.

## Grounding

- Ground every important claim in files you opened: source, configuration, tests, scripts, CI, and docs. Cite repository-relative paths such as `src/server.ts`, never absolute paths.
- Make the footing of a claim clear when it isn't obvious:
  - **Observed**: the code or configuration shows it.
  - **Documented**: the repository's own prose says it. Documentation states intent; a README describing a feature doesn't show that the feature works.
  - **Inferred**: your reading of the evidence. Say that it's inferred and keep the caveat.
- When the evidence runs out, say what is unknown. An admitted gap costs the reader less than a confident wrong statement.

## What files don't show

- A test file doesn't show that the test passes, or that anything runs it.
- A configuration file doesn't show that anything is deployed with it.
- A reference to a function doesn't show that it runs on any particular path.
- Not finding something means you didn't find it, not that it doesn't exist.
- Directories are layout, not components. `src/`, `lib/`, and `utils/` aren't architecture; name components by what they're responsible for.
- Test fixtures aren't features, and generated files and lockfiles aren't design decisions.

## Inspection order

1. README, manifests (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, and similar), build files, CI configuration, Dockerfiles, and obvious entry points.
2. The main source directories, then the tests.
3. Skip dependency directories, build output, binaries, and lockfiles unless setup depends on them.

When the entry points and the directory layout suggest different structures, the entry points are usually right.

## Writing

- Write like a senior engineer onboarding another engineer: clear, practical, direct.
- Prefer clarity over completeness, and keep documents skimmable.
- No raw file dumps and no hype. Skip words like "seamless" and "leverages", and don't call anything "robust", "scalable", or "production-ready" unless the repository clearly supports it.
- Don't overstate architectural sophistication.
- Use the headings the audience guide lists, in order. If a section has nothing grounded to say, say so in a line instead of padding it.
- A document contains only the document: no code fence around it and no notes about how you produced it.
