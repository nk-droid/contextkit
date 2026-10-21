import { getD1 } from ".";
import type { NetworkFacts } from "../app/facts/schema";

export type FactsSummary = {
  id: string;
  name: string;
  sourceLabel: string;
  revision: string | null;
  artifactId: string;
  componentCount: number;
  symbolCount: number;
  createdAt: string;
  updatedAt: string;
};

// D1 stores at most 2,000,000 bytes in one row.
const maxContentBytes = 1_900_000;

const createStatements = [
  `CREATE TABLE IF NOT EXISTS facts_documents (
    repository_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    source_label TEXT NOT NULL,
    revision TEXT,
    artifact_id TEXT NOT NULL,
    component_count INTEGER NOT NULL,
    symbol_count INTEGER NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS facts_documents_updated_at_idx ON facts_documents(updated_at)",
];

export class FactsTooLargeError extends Error {}

export async function ensureFactsSchema() {
  const d1 = getD1();
  await d1.batch(createStatements.map((statement) => d1.prepare(statement)));
}

export async function listFacts(): Promise<FactsSummary[]> {
  await ensureFactsSchema();
  const result = await getD1()
    .prepare(
      `SELECT repository_id AS id, name,
        source_label AS sourceLabel,
        revision,
        artifact_id AS artifactId,
        component_count AS componentCount,
        symbol_count AS symbolCount,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM facts_documents
      ORDER BY updated_at DESC, name ASC`,
    )
    .all<FactsSummary>();
  return result.results;
}

export async function getFacts(repositoryId: string): Promise<NetworkFacts | null> {
  await ensureFactsSchema();
  const row = await getD1()
    .prepare("SELECT content FROM facts_documents WHERE repository_id = ?")
    .bind(repositoryId)
    .first<{ content: string }>();
  return row ? (JSON.parse(row.content) as NetworkFacts) : null;
}

export async function saveFacts(facts: NetworkFacts) {
  const content = JSON.stringify(facts);
  const contentBytes = new TextEncoder().encode(content).byteLength;
  if (contentBytes > maxContentBytes) {
    throw new FactsTooLargeError(
      `The network part of this document is ${(contentBytes / 1_000_000).toFixed(1)} MB; D1 stores at most 2 MB per repository.`,
    );
  }
  await ensureFactsSchema();
  const now = new Date().toISOString();
  const { repository } = facts;
  await getD1()
    .prepare(
      `INSERT INTO facts_documents (
        repository_id, name, source_label, revision, artifact_id,
        component_count, symbol_count, content, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(repository_id) DO UPDATE SET
        name = excluded.name,
        source_label = excluded.source_label,
        revision = excluded.revision,
        artifact_id = excluded.artifact_id,
        component_count = excluded.component_count,
        symbol_count = excluded.symbol_count,
        content = excluded.content,
        updated_at = excluded.updated_at`,
    )
    .bind(
      repository.id,
      repository.displayName || repository.name,
      repository.sourceLabel,
      repository.revision,
      facts.artifactId,
      facts.architecture.components.length,
      facts.code.symbols.length,
      content,
      now,
      now,
    )
    .run();
}

export async function deleteFacts(repositoryId: string) {
  await ensureFactsSchema();
  await getD1()
    .prepare("DELETE FROM facts_documents WHERE repository_id = ?")
    .bind(repositoryId)
    .run();
}
