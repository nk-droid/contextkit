/**
 * Evaluation fixture: a repository that is mostly *about* code rather than running it.
 *
 * Documentation tooling, a test-fixture builder, a signal table, a lockfile of
 * transitive dependencies. Almost every pattern a detector looks for appears somewhere
 * here, and almost none of it is implementation.
 *
 * This is the adversarial half of the corpus. The other fixtures check that real facts
 * are found; this one checks that plausible-looking non-facts are not, which is the
 * failure that survives review because a wrong fact reads exactly like a right one.
 */
export const repository = {
  name: "sample-heavy",
  description: "Docs, fixtures, and signal tables that must not be read as implementation.",

  files: {
    "package.json": JSON.stringify({
      name: "contextkit-like-tool",
      version: "0.1.0",
      scripts: { test: "node --test" },
      dependencies: {},
    }, null, 2),

    // A lockfile naming technologies nothing here has adopted.
    "package-lock.json": JSON.stringify({
      name: "contextkit-like-tool",
      lockfileVersion: 3,
      packages: {
        "node_modules/@opentelemetry/api": { version: "1.9.0" },
        "node_modules/better-sqlite3": { version: "11.0.0" },
        "node_modules/@sentry/node": { version: "8.0.0" },
      },
    }, null, 2),

    // The self-detection case: a detector's own signal table.
    "src/signals.ts": `export const OBSERVABILITY_SIGNALS = [
  { name: "OpenTelemetry", pattern: /@opentelemetry/ },
  { name: "Sentry", pattern: /@sentry/ },
];

export const STORE_SIGNALS = [
  { technology: "PostgreSQL", pattern: /\\bpg\\b/ },
  { technology: "Redis", pattern: /\\bredis\\b/ },
];
`,

    // A fixture builder: real code whose strings contain sample code.
    "src/build-fixture.ts": `export function buildFixture(write) {
  write("server.ts", 'app.get("/from-a-builder", handler);');
  write("schema.ts", 'export const ghosts = sqliteTable("ghosts", {});');
  write("worker.py", '@router.post("/also-a-ghost")');
}
`,

    // Documentation full of examples.
    "docs/routing.md": `# Routing

Register a route like this:

\`\`\`ts
app.post("/documented-only", handler);
\`\`\`

Or with a router:

\`\`\`ts
router.delete("/also-documented-only", handler);
\`\`\`
`,

    // Commented-out implementation.
    "src/server.ts": `export function mount(app) {
  // app.get("/removed-last-year", handler);
  /* app.put("/removed-too", handler); */
  return app;
}
`,

    // The one real thing in the repository.
    "src/index.ts": `import { buildFixture } from "./build-fixture";

export function main() {
  return buildFixture(() => {});
}
`,
  },

  expect: {
    // Nothing in this repository registers a route, declares an entity, or adopts an
    // observability stack. Every candidate is documentation, a sample, or a dependency
    // of a dependency.
    routes: { present: [], absent: [
      "/from-a-builder", "/also-a-ghost", "/documented-only",
      "/also-documented-only", "/removed-last-year", "/removed-too",
    ] },
    dataEntities: { present: [], absent: ["ghosts"] },
    observability: { present: [], absent: ["OpenTelemetry", "Sentry"] },
    dataStores: { present: [], absent: ["PostgreSQL", "Redis", "SQLite"] },
    symbols: { present: ["buildFixture", "main", "mount"] },
  },
};
