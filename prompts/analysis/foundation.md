# Slice 1: foundation

Establish what this repository is and what it is made of. Later slices reference the
component and external-system ids you create here, so they are frozen once this slice
validates — choose them carefully and name them for what they do.

## Produce

**project** — what the repository is for, in one or two sentences a new maintainer would
find useful. Prefer `documented` basis when the README says it plainly; use `inferred`
only when you are reading it from structure, and say so.

**components** — the parts a maintainer would name when describing this system. Group by
responsibility, not by directory depth: `src/analysis/extractors/languages/` and
`src/analysis/extractors/frameworks/` are probably one component, not two. Every path you
assign must exist in the inventory.

A good component list is short enough to hold in mind — usually three to eight for a
repository this size. If you find yourself at fifteen, you are describing directories
rather than components.

**externalSystems** — systems this repository talks to but does not contain. A dependency
is not automatically an external system: a JSON parser is a library, a payment API is an
external system. Look for base URLs, client construction, database bindings, and
credential names rather than package lists.

**annotations** — enrichment joined onto existing records by id. Useful ones here:

- on a file path: `purpose`, `summary`, `importance`, `componentId`
- on a symbol id: `summary`, `responsibility`, `componentId`
- on a technology or dependency id: `purpose`, `scope`

Annotate what matters. Fifty thin annotations are worth less than eight that explain the
files someone must read first.

## Method

1. Read the briefing, then `contextkit://runs/<run-id>/static` for coverage — know what
   the scanner could not parse before drawing conclusions from absence.
2. Read the inventory and the top-level directory map. Form a first guess at components.
3. Check that guess against entrypoints, routes, and manifests. Where they disagree with
   the directory layout, the entrypoints are usually right.
4. For each component, find one or two records that demonstrate it and cite their
   evidence ids.
5. Call `validate_slice` and fix anything it reports.

## Watch for

- **Directories are not components.** `src/`, `lib/`, and `utils/` are layout.
- **Test fixtures are not features.** A route or model defined inside a test fixture
  belongs to the test suite, not to the API.
- **Generated code is not authored intent.** Lockfiles and build output describe what a
  tool produced.
- **Coverage gaps look like absence.** If the scanner parsed no SQL, do not conclude the
  system has no schema; record an unknown instead.
