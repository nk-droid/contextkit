# Slice 1: foundation

Establish what this repository is and what it is made of. The component and
external-system ids you create are frozen once this slice validates — every later slice
references them — so name them for what they do and choose carefully.

## Produce

**components** — the parts a maintainer would name when describing this system. Group by
responsibility, not directory depth: `extractors/languages/` and `extractors/frameworks/`
are probably one component, not two. A good list is short enough to hold in mind, usually
three to eight for a repository of this size. At fifteen you are describing directories.

Each needs `summary` (its architectural role in one or two sentences), `responsibilities`
(what it owns) and `nonResponsibilities` (adjacent behaviour it does *not* own, which is
what stops a reader attributing a bug to the wrong place). `paths` must exist in the
inventory. The id lists — `entrypointIds`, `technologyIds`, `publicInterfaceIds`,
`stateStoreIds` — reference records from the briefing; leave one empty rather than
guessing at it.

`lifecycle` is `active` unless the repository shows otherwise. `ownerHint` is null unless
a CODEOWNERS file or equivalent names someone.

**externalSystems** — systems this repository talks to but does not contain. A dependency
is not automatically an external system: a JSON parser is a library, a payment API is an
external system. Look for base URLs, client construction, database bindings, and
credential names rather than package lists. `required` means the system cannot function
without it.

**primaryUsers / capabilities / nonGoals** — grounded statements, one idea each.
Capabilities are what the system does for those users. `nonGoals` are things it
deliberately does not do; leave the array empty rather than inventing them, because a
fabricated non-goal is worse than a missing one.

**repositoryRoles** — what kind of repository this is, as plain strings: `service`,
`library`, `cli`, `web-app`, `monorepo`, `infrastructure`, or similar. More than one is
normal; a repository holding both a service and its CLI is both.

**styles** — architectural patterns the code actually exhibits, not ones it resembles.
"Event-driven via a queue" needs a queue. Leave empty if nothing is clear.

**annotations** — enrichment joined onto existing records by id: `purpose` and `summary`
on the files someone must read first, `componentId` on files and symbols, `purpose` and
`scope` on technologies, and `purpose`, `affectedComponentIds`, or `fallbackBehavior`
on dependencies. Do not set `scope` on dependencies. Annotate what matters — eight annotations that
explain the entry points beat fifty thin ones. **Dependencies are worth annotating**: a
reader wants to know why a library is here, not just that it is.

## Grounding

Every record carries `grounding` with `basis`, `confidence`, `evidenceIds`, `claimIds`,
and `notes`. Use `confidence` honestly — `low` on a component you inferred from directory
names is more useful than false certainty. Put qualifications in `notes` rather than
weakening the summary.

## Method

1. Read the briefing, then `contextkit://runs/<run-id>/static` for coverage. Know what the
   scanner could not parse before drawing conclusions from absence.
2. Read the inventory and directory map. Form a first guess at components.
3. Check that guess against entrypoints, routes, and manifests. Where they disagree with
   the directory layout, the entrypoints are usually right.
4. For each component, cite evidence that demonstrates it.
5. Call `validate_slice` and fix what it reports.

## Watch for

- **Directories are not components.** `src/`, `lib/`, `utils/` are layout.
- **Test fixtures are not features.** A route defined inside a test fixture belongs to the
  test suite, not the API.
- **Generated code is not authored intent.** Lockfiles describe what a tool produced.
- **Coverage gaps look like absence.** If no SQL was parsed, do not conclude there is no
  schema — record an unknown.
