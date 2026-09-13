/**
 * Storage detectors: data stores, entities, and migrations.
 *
 * Records schema and connection declarations. Which store actually owns a piece of
 * state, what its retention is, and whether a migration is safe are all semantic
 * questions and are deliberately absent here.
 */
import path from "node:path";
import { detectionId } from "../../stable-ids.mjs";
import { ExtractorRun } from "../extractor.mjs";
import { buildCodeMask, firstMatchInCode, isAuthored, lineAt, matchesInCode } from "../source-text.mjs";

const VERSION = "1.0.0";

/** Connection-string and client constructions that name a concrete store technology. */
const STORE_SIGNALS = [
  { kind: "relational-database", technology: "PostgreSQL", pattern: /\b(postgresql|postgres):\/\/|\bpsycopg|\basyncpg\b/i },
  { kind: "relational-database", technology: "MySQL", pattern: /\bmysql:\/\//i },
  { kind: "relational-database", technology: "SQLite", pattern: /\bsqlite:\/\/|\bsqlite3\b/i },
  { kind: "key-value-store", technology: "Redis", pattern: /\bredis:\/\/|\bfrom redis\b|\bimport redis\b|from ["']redis["']/i },
  { kind: "document-database", technology: "MongoDB", pattern: /\bmongodb(\+srv)?:\/\//i },
  { kind: "relational-database", technology: "Cloudflare D1", pattern: /\bD1Database\b|\bd1_databases\b/ },
  { kind: "object-store", technology: "S3", pattern: /\bs3\.(client|resource)\b|\bS3Client\b|\bR2Bucket\b/ },
];

/** ORM model and table declarations, by framework. */
const ENTITY_SIGNALS = [
  { framework: "drizzle", pattern: /\b(?:export\s+const\s+)([A-Za-z_]\w*)\s*=\s*(?:sqliteTable|pgTable|mysqlTable)\s*\(\s*["']([^"']+)["']/g },
  { framework: "sqlalchemy-core", pattern: /\b([A-Za-z_]\w*)\s*=\s*Table\s*\(\s*["']([^"']+)["']/g },
  { framework: "sqlalchemy-orm", pattern: /class\s+([A-Za-z_]\w*)\s*\([^)]*\bBase\b[^)]*\):[\s\S]{0,200}?__tablename__\s*=\s*["']([^"']+)["']/g },
  { framework: "django-orm", pattern: /class\s+([A-Za-z_]\w*)\s*\(\s*models\.Model\s*\):()/g },
  { framework: "prisma", pattern: /^model\s+([A-Za-z_]\w*)\s*\{()/gm },
];

export function detectStorage(ctx) {
  const run = new ExtractorRun({
    name: "framework.storage", version: VERSION, exactness: "mixed",
    supports: ["drizzle", "sqlalchemy", "django-orm", "prisma", "raw-sql"],
  });

  const stores = new Map();
  const entities = [];
  const migrations = [];

  for (const [relPath, text] of ctx.contents) {
    const ext = path.extname(relPath);
    // Signals found in comments or string literals are documentation, not usage - most
    // visibly when a detector matches its own signal table.
    const mask = buildCodeMask(text, relPath);
    // Signal matching runs over authored files only; migrations below deliberately do
    // not, since a generated migration is still a real fact.
    const authored = isAuthored(ctx.file?.(relPath));

    for (const signal of STORE_SIGNALS) {
      if (!authored) break;
      const match = firstMatchInCode(text, signal.pattern, mask);
      if (!match) continue;
      run.consider();
      const line = lineAt(text, match.index);
      const evId = ctx.evidence.add({
        path: relPath, lineStart: line, lineEnd: line,
        detail: `references ${signal.technology}`,
        sourceText: text, region: `store-${signal.technology}`,
      });
      const id = detectionId("store", signal.technology);
      if (!stores.has(id)) {
        stores.set(id, {
          id, detector: run.name, confidence: "medium", evidenceIds: [],
          name: signal.technology, kind: signal.kind,
          technology: signal.technology, definitionPaths: [],
        });
      }
      const store = stores.get(id);
      if (evId) store.evidenceIds.push(evId);
      if (!store.definitionPaths.includes(relPath)) store.definitionPaths.push(relPath);
      run.emitted();
    }

    for (const signal of ENTITY_SIGNALS) {
      if (!authored) break;
      for (const match of matchesInCode(text, signal.pattern, mask)) {
        run.consider();
        const line = lineAt(text, match.index);
        const evId = ctx.evidence.add({
          path: relPath, lineStart: line, lineEnd: line,
          detail: `declares the ${signal.framework} entity ${match[1]}`,
          sourceText: text, region: `entity-${match[1]}`,
        });
        entities.push({
          id: detectionId("entity", relPath, match[1]),
          detector: run.name, confidence: "medium", evidenceIds: [evId].filter(Boolean),
          name: match[1],
          tableName: match[2] || null,
          framework: signal.framework,
          definitionPath: relPath,
          lineStart: line,
        });
        run.emitted();
      }
    }

    // Migrations: a numbered or timestamped file under a migrations directory, or raw SQL DDL.
    const inMigrationDir = /(^|\/)(migrations|drizzle|alembic\/versions)\//.test(relPath);
    if (inMigrationDir || (ext === ".sql" && /\bCREATE\s+TABLE\b/i.test(text))) {
      run.consider();
      const evId = ctx.evidence.add({
        path: relPath, lineStart: 1, lineEnd: Math.min(12, ctx.lineCount(relPath) ?? 1),
        detail: "declares a schema migration", sourceText: text, region: "migration",
      });
      const sequence = /(\d{4,})/.exec(path.basename(relPath));
      migrations.push({
        id: detectionId("migration", relPath),
        detector: run.name, confidence: inMigrationDir ? "high" : "medium",
        evidenceIds: [evId].filter(Boolean),
        path: relPath,
        sequence: sequence ? sequence[1] : null,
        // Whether it can be rolled back is a property of the tool and the content,
        // not something the presence of the file establishes.
        declaresDownMigration: /\b(DROP\s+TABLE|-- *down|def downgrade)\b/i.test(text),
      });
      run.emitted();
    }
  }

  return {
    dataStores: [...stores.values()]
      .map((s) => ({ ...s, evidenceIds: [...new Set(s.evidenceIds)], definitionPaths: s.definitionPaths.sort() }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    dataEntities: entities.sort((a, b) => (a.id < b.id ? -1 : 1)),
    migrations: migrations.sort((a, b) => (a.id < b.id ? -1 : 1)),
    provenance: run.finish(),
  };
}
