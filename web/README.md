# ContextKit repository graph UI

This React application imports validated `REPO_GRAPH.json` artifacts, stores them in SQLite, and renders interactive architecture and flow graphs. Its `/network` page does the same for context facts documents and draws them as a component network.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

From the repository root, `bin/contextkit view <file|directory>` installs these dependencies on first run, starts the server, imports a `REPO_GRAPH.json` or `NETWORK_FACTS.json`, and opens it. To run the server by hand:

```bash
cd ..
npm ci --ignore-scripts
cd web
npm ci
npm run dev
```

## Data flow

- The CLI creates a portable `REPO_GRAPH.json` file.
- The browser imports the file through `POST /api/repositories`.
- The API revalidates it and upserts the document and summary metadata.
- React Flow renders a Dagre-computed layout without altering stored graph data.

The component network at `/network` follows the same pattern for context facts documents:

- From the repository root, run `bin/contextkit network <local-path-or-public-git-url>`
  and import the printed `NETWORK_FACTS.json`. Add `--provider claude` or
  `--provider codex` for semantic architecture; static mode needs no model account.
- The CLI, browser and API share `src/network/schema.mjs`, including ID, evidence,
  ownership and dangling-link checks. Coverage and missing layers appear under
  the repository selector.

- The browser parses the facts JSON with `app/facts/schema.ts`, which keeps only the fields the network reads.
- `POST /api/facts` validates that part again and upserts it into `facts_documents`, keyed by repository ID.
- `app/facts/network.ts` turns it into nodes and links, and `app/facts/orb.ts` draws them as a rotating orb on a canvas.

Importing a `REPO_GRAPH.json` there is refused with a pointer back to the atlas.

The `DB` binding uses Cloudflare D1, which is SQLite-compatible. During local development its files live under `.wrangler/state/`. A fresh database has no rows and the app ships with no seed data.

## Commands

- `npm run dev`: start the local application
- `npm run typecheck`: run TypeScript checks
- `npm run lint`: run ESLint
- `npm run build`: produce a production build
- `npm run db:generate`: regenerate the Drizzle SQL migration after schema changes

## Schema changes

```bash
npm run db:generate
```

Inspect the generated SQL in `drizzle/` before committing it. The API also creates missing tables defensively, which keeps a first local run usable without a separate migration command.
