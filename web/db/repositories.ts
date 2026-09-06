import { getD1 } from ".";
import type { RepoGraphFile } from "../app/graph/schema";

export type RepositorySummary = {
  id: string;
  name: string;
  source: string;
  revision: string | null;
  description: string | null;
  schemaVersion: number;
  graphCount: number;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
  updatedAt: string;
};

const createStatements = [
  `CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    revision TEXT,
    description TEXT,
    schema_version INTEGER NOT NULL,
    graph_count INTEGER NOT NULL,
    node_count INTEGER NOT NULL,
    edge_count INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS graph_documents (
    repository_id TEXT PRIMARY KEY NOT NULL,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
  )`,
  "CREATE INDEX IF NOT EXISTS repositories_updated_at_idx ON repositories(updated_at)",
];

export async function ensureRepositorySchema() {
  const d1 = getD1();
  await d1.batch(createStatements.map((statement) => d1.prepare(statement)));
}

export async function listRepositories(): Promise<RepositorySummary[]> {
  await ensureRepositorySchema();
  const result = await getD1()
    .prepare(
      `SELECT id, name, source, revision, description,
        schema_version AS schemaVersion,
        graph_count AS graphCount,
        node_count AS nodeCount,
        edge_count AS edgeCount,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM repositories
      ORDER BY updated_at DESC, name ASC`,
    )
    .all<RepositorySummary>();
  return result.results;
}

export async function getRepository(
  repositoryId: string,
): Promise<RepoGraphFile | null> {
  await ensureRepositorySchema();
  const row = await getD1()
    .prepare("SELECT content FROM graph_documents WHERE repository_id = ?")
    .bind(repositoryId)
    .first<{ content: string }>();
  return row ? (JSON.parse(row.content) as RepoGraphFile) : null;
}

export async function saveRepository(graphFile: RepoGraphFile) {
  await ensureRepositorySchema();
  const d1 = getD1();
  const now = new Date().toISOString();
  const graphCount = graphFile.graphs.length;
  const nodeCount = graphFile.graphs.reduce(
    (total, graph) => total + graph.nodes.length,
    0,
  );
  const edgeCount = graphFile.graphs.reduce(
    (total, graph) => total + graph.edges.length,
    0,
  );

  await d1.batch([
    d1
      .prepare(
        `INSERT INTO repositories (
          id, name, source, revision, description, schema_version,
          graph_count, node_count, edge_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          source = excluded.source,
          revision = excluded.revision,
          description = excluded.description,
          schema_version = excluded.schema_version,
          graph_count = excluded.graph_count,
          node_count = excluded.node_count,
          edge_count = excluded.edge_count,
          updated_at = excluded.updated_at`,
      )
      .bind(
        graphFile.repository.id,
        graphFile.repository.name,
        graphFile.repository.source,
        graphFile.repository.revision ?? null,
        graphFile.repository.description ?? null,
        graphFile.schemaVersion,
        graphCount,
        nodeCount,
        edgeCount,
        now,
        now,
      ),
    d1
      .prepare(
        `INSERT INTO graph_documents (repository_id, content, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(repository_id) DO UPDATE SET
          content = excluded.content,
          updated_at = excluded.updated_at`,
      )
      .bind(graphFile.repository.id, JSON.stringify(graphFile), now),
  ]);
}

export async function deleteRepository(repositoryId: string) {
  await ensureRepositorySchema();
  await getD1()
    .prepare("DELETE FROM repositories WHERE id = ?")
    .bind(repositoryId)
    .run();
}
