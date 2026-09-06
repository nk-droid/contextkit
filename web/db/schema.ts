import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const repositories = sqliteTable(
  "repositories",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    source: text("source").notNull(),
    revision: text("revision"),
    description: text("description"),
    schemaVersion: integer("schema_version").notNull(),
    graphCount: integer("graph_count").notNull(),
    nodeCount: integer("node_count").notNull(),
    edgeCount: integer("edge_count").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("repositories_updated_at_idx").on(table.updatedAt),
  ],
);

export const graphDocuments = sqliteTable("graph_documents", {
  repositoryId: text("repository_id")
    .primaryKey()
    .references(() => repositories.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  updatedAt: text("updated_at").notNull(),
});
