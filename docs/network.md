# Component Network

`bin/contextkit network` builds `NETWORK_FACTS.json`, the input to the explorer's `/network` page. The [README](../README.md#component-network) covers everyday usage; this page covers how the pipeline works, what the export contains, and how it fails.

## How it works

Both modes produce the same validated network contract. The command:

1. Scans the repository into a frozen run outside the target by default.
2. In semantic mode, runs foundation followed by behavior/data, or reuses
   compatible validated results. Schema hashes, contract versions, source
   fingerprints, model/exposure settings, and foundation-result hashes guard reuse.
3. Joins annotations onto scanner facts, assigns unambiguous component ownership,
   calculates cross-component calls, and reports conflicting annotations. Semantic
   projections that reuse a matching scanner detection ID receive a separate stable
   ID, with references updated; validation reports record the mapping and the original
   provider response stays unchanged.
4. Checks schema, IDs, links, evidence and the web import size limit before
   atomically replacing the export. A failed run preserves the previous export.

## Providers

Semantic mode sends static facts and bounded evidence excerpts to the selected
provider. `--source-exposure cached-source` additionally enables access to cached
source chunks; the default is `static-only`. Use `--model <id>` to select a model.
Each semantic slice has a 900-second timeout by default; `--timeout-seconds`
overrides it. Claude also defaults to 60 turns per slice (`--max-turns`).
Private repositories should be supplied as local checkouts. Remote acquisition
accepts public HTTP(S) clone URLs and `file://` Git mirrors, without embedded
credentials; submodules are not recursively cloned and repository scripts are
never executed.

### Agent mode

The agent running the `repo-network` skill can do the semantic slices itself instead
of ContextKit launching a provider. It prepares each slice, calls the same tools as
commands, and submits a result that goes through the same validation:

```bash
bin/contextkit-analyze /path/to/run-directory --slice foundation --provider agent --prepare
bin/contextkit-mcp /path/to/run-directory call search_facts '{"query":"route"}' \
  --provider agent --slice foundation
bin/contextkit-analyze /path/to/run-directory --slice foundation --provider agent --result result.json
# Repeat for behavior-data, then export the validated slices:
bin/contextkit network /path/to/run-directory --provider agent --output /path/to/NETWORK_FACTS.json
```

Agent mode defaults to `cached-source`, which is what lets the agent resolve new
evidence. ContextKit cannot confine an agent it did not launch: the agent may read the
repository directly, and only its `contextkit-mcp` calls are logged. Validation still
rejects evidence that is not from the run and changes to scanner-measured values.

## Output and run artifacts

Output defaults to ContextKit's `context-packs/<name>-<source-id>/`, independent
of the invoking directory. When that would be inside the analyzed repository,
it uses the system temporary directory's `contextkit-output/` instead. Set
`--output` for a permanent location when analyzing ContextKit itself.
Run artifacts live beside the export under `.contextkit/work/`; `--work-dir`
overrides that directory. These artifacts contain private source excerpts.
`--allow-untracked` includes non-ignored untracked files in local scans.

## Coverage

Coverage is stored in the export and shown in the UI. All local repositories can
produce directory networks, including repositories without a package manifest.
Symbol/call extraction currently supports JavaScript, TypeScript and Python;
other languages retain directory coverage and are listed as unsupported for code
extraction. The scanner retains up to 400 prioritized symbols by default. Risk and
shared-resource layers have no semantic producer yet and are explicitly marked
as not analyzed, rather than presented as absent findings.

## What the export contains

In the Orb projection, component `publicInterfaceIds` link only to exported API
surfaces. Scanner references to commands, entrypoints, symbols and other records
remain in the saved foundation response; export warnings identify references
omitted from this field. API ownership is derived from endpoint implementation
paths, and data contracts connect producers and consumers through their own links.
Unknown references still fail validation.

Store access, API consumers, and data-contract producers/consumers link only to
exported components, external systems, and stores. References to known data entities,
runtime flows, or scanner records outside that set are omitted with a warning; their
full records remain in the saved analysis. The exporter does not guess replacement
actors from a data entity's store or definition paths.

`NETWORK_FACTS.json` is the supported network projection, not a claim that every
section of the larger `CONTEXT_FACTS.json` contract has been generated.

## Failure modes

- **Static validation failure:** the CLI prints representative errors and the path
  to `STATIC_VALIDATION.json`, retaining the failed scan for diagnosis. Valid scans
  also keep this report in their run directory. Scanner IDs include full-input
  hashes, so long paths and case differences remain distinct; conditional Python
  requirements and repeated Make target declarations are handled without duplicate IDs.
- **Export failure after both slices are VALID:** the completed analysis is saved.
  After fixing the export error, use `bin/contextkit-export-network <run-directory>
  --provider <claude|codex|agent> --output <file>` to retry locally without another model
  call. Use the run directory printed by the failed command.
- **Old saved analysis:** responses without a matching schema hash must be
  regenerated. The network command refreshes incompatible responses; the standalone
  exporter refuses them. Renaming old fields cannot supply missing semantic facts.
  Rescanning with changed scanner rules or limits also changes the static artifact
  identity, preventing reuse of semantic responses based on older scanner facts.
- **Provider failure:** authentication, quota, malformed output, or evidence
  validation errors stop publication. Fix the reported error and rerun the command;
  compatible completed slices are reused. An invalid candidate from the same frozen
  request is retried with its validation errors included in the prompt.
  Use `--provider static` for an explicitly
  limited network without a model.
- **Git clone failure:** supply a clone URL, not a repository's web/tree page, or
  use a local checkout. Network access is needed only for remote acquisition and
  semantic providers.
- **Import too large:** the network projection must fit the web database's
  1.9 MB export limit. Analyze a narrower local directory if that limit is exceeded.
