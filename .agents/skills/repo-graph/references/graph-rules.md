# Repository graph rules

`REPO_GRAPH.json` is a small, evidence-backed map of a repository, drawn as one or more views. Every node and edge either cites repository files or says it is inferred.

## Document shape

Schema version 1. A minimal valid document:

```json
{
  "schemaVersion": 1,
  "repository": {
    "id": "acme-billing",
    "name": "Acme Billing",
    "source": "https://github.com/acme/billing",
    "revision": "4f2a9c1"
  },
  "graphs": [
    {
      "id": "architecture",
      "kind": "architecture",
      "title": "Architecture",
      "description": "HTTP API in front of a Postgres-backed billing service.",
      "nodes": [
        {
          "id": "api-server",
          "label": "API server",
          "kind": "entrypoint",
          "path": "src/server.ts",
          "summary": "Starts the HTTP server and registers the billing routes.",
          "basis": "observed",
          "evidence": [{ "path": "src/server.ts", "detail": "Calls app.listen and mounts routes/billing.ts." }]
        },
        {
          "id": "postgres",
          "label": "Postgres",
          "kind": "data-store",
          "summary": "Stores invoices and customers.",
          "basis": "observed",
          "evidence": [{ "path": "src/db/client.ts", "detail": "Creates the pg Pool from DATABASE_URL." }]
        }
      ],
      "edges": [
        {
          "id": "api-server-writes-postgres",
          "source": "api-server",
          "target": "postgres",
          "kind": "writes",
          "label": "writes invoices",
          "basis": "observed",
          "evidence": [{ "path": "src/routes/billing.ts", "detail": "INSERT INTO invoices in createInvoice." }]
        }
      ]
    }
  ],
  "warnings": []
}
```

Fields:

- `repository`: `id` is a slug of the repository name (lowercase letters, digits, hyphens); `name` is human-readable; `source` is the URL or path you analyzed; `revision` is `git rev-parse --short HEAD`, or `null`. Optional: `description`.
- Graph: `id`, `kind`, `title`, `description`, `nodes` (1 to 300), `edges` (up to 1,000). Graph ids are unique in the document.
- Node: `id`, `label`, `kind`, `summary`, `basis`; optional `path` and `evidence`. Node ids are unique in their graph.
- Edge: `id`, `source`, `target`, `kind`, `label`, `basis`; optional `evidence`. Edge ids are unique in their graph, and `source` and `target` are node ids from the same graph.
- Evidence: `path` plus an optional `detail` that makes the claim checkable.
- `warnings` (optional): strings about limits, gaps, and uncertainty.

No other fields are allowed. The full contract is `repo-graph.schema.json`, next to this file.

## Views

| `kind` | Shows | Include |
|---|---|---|
| `architecture` | Services, modules, stores, and their structural relationships | Always |
| `runtime-flow` | Execution from an entry point through each runtime step | When the code shows a clear flow |
| `imports` | Imports, shared packages, and dependency boundaries | When boundaries between parts matter |
| `deployment` | Build artifacts, infrastructure, and deployment topology | When build or deploy files define one |

## Node kinds

`entrypoint` (where execution starts: CLI command, server, worker, handler), `module` (a part of the codebase with one responsibility), `data-store` (database, cache, queue, file store), `external` (a system outside the repository), `config`, `agent` (an AI or automated actor), `policy` (rules that permit or deny), `observability` (logs, metrics, traces), `stage` (a step in a flow or pipeline), `gate` (a check that can stop a flow), `output` (an artifact the system produces).

## Edges

`kind` groups edges for filtering in the explorer, so reuse a small vocabulary: `calls`, `imports`, `reads`, `writes`, `configures`, `emits`, `publishes`, `dispatches`. The explorer animates `publishes` and `dispatches` in runtime-flow views. `label` is a short phrase for the specific relationship, such as "writes invoices".

## Grounding

- `basis: "observed"` requires at least one evidence entry, and every evidence `path` and node `path` must exist in the repository.
- Use `basis: "inferred"` when a relationship is plausible but no file establishes it, and say why in the summary, label, or `warnings`.
- Paths are relative to the repository root: no leading `/`, no drive letters, no `..`.
- Don't invent services, dependencies, commands, or runtime behavior.
- Prefer a small, useful graph to a large speculative one. Leave out generated files and third-party dependencies unless they're essential to the architecture.
- Use stable, descriptive ids such as `billing-api`, not `node-1`.
