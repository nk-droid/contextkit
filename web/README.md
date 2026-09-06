# ContextKit repository graph UI

This React application imports validated `REPO_GRAPH.json` artifacts, stores them in SQLite, and renders interactive architecture and flow graphs.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```bash
npm ci
npm run dev
```

## Data flow

- The CLI creates a portable `REPO_GRAPH.json` file.
- The browser imports the file through `POST /api/repositories`.
- The API revalidates it and upserts the document and summary metadata.
- React Flow renders a Dagre-computed layout without altering stored graph data.

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
