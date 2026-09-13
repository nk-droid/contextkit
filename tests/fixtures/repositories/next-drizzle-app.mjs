/**
 * Evaluation fixture: a Next.js app with Drizzle storage on Cloudflare.
 *
 * Sample source lives in template literals so it is masked out of ContextKit's own
 * scan - a fixture that plants phantom routes in the repository it ships with would
 * undermine the very accuracy it is meant to guard.
 */
export const repository = {
  name: "next-drizzle-app",
  description: "TypeScript web app: file-system routes, Drizzle entities, npm scripts.",

  files: {
    "package.json": JSON.stringify({
      name: "storefront",
      version: "2.3.0",
      private: true,
      scripts: {
        dev: "next dev",
        build: "next build",
        test: "vitest run",
        "db:migrate": "drizzle-kit migrate",
      },
      dependencies: { next: "^15.0.0", "drizzle-orm": "^0.36.0" },
      devDependencies: { typescript: "^5.6.0", vitest: "^2.1.0" },
      engines: { node: ">=20" },
    }, null, 2),

    "src/db/schema.ts": `import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
});

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  customerId: text("customer_id").notNull(),
  total: integer("total").notNull(),
});
`,

    "src/db/client.ts": `import { drizzle } from "drizzle-orm/d1";

export function createClient(binding) {
  return drizzle(binding);
}
`,

    "src/app/api/orders/route.ts": `import { createClient } from "../../../db/client";

export async function GET(request) {
  const db = createClient(request.env.DB);
  return Response.json(await listOrders(db));
}

export async function POST(request) {
  const db = createClient(request.env.DB);
  return Response.json(await createOrder(db, await request.json()));
}

async function listOrders(db) {
  return db.select();
}

async function createOrder(db, payload) {
  return db.insert(payload);
}
`,

    "src/app/api/customers/[id]/route.ts": `export async function GET(request, context) {
  return Response.json({ id: context.params.id });
}
`,

    "wrangler.toml": `name = "storefront"
compatibility_date = "2025-01-01"

[[d1_databases]]
binding = "DB"
database_name = "storefront-production"
`,

    "migrations/0001_initial.sql": `CREATE TABLE customers (id TEXT PRIMARY KEY, email TEXT NOT NULL);
CREATE TABLE orders (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, total INTEGER NOT NULL);
`,

    "README.md": `# Storefront

A small commerce API.

## Example

Older revisions registered routes manually:

    app.get("/legacy-orders", listOrders);

That style is gone; routing is file-system based.
`,
  },

  /**
   * Reviewed expectations, not a recorded snapshot. Each entry is a claim someone
   * checked against the fixture by reading it, which is what makes a failure meaningful
   * rather than merely different.
   */
  expect: {
    routes: {
      // Next's file-system routing: one record per exported HTTP verb.
      present: ["/api/orders", "/api/orders", "/api/customers/:id"],
      absent: ["/legacy-orders"], // documented in the README, not implemented
    },
    dataEntities: { present: ["customers", "orders"], absent: [] },
    dataStores: { presentAny: ["SQLite", "Cloudflare D1", "Drizzle"] },
    dependencies: { present: ["next", "drizzle-orm", "typescript", "vitest"] },
    commands: { present: ["dev", "build", "test", "db:migrate"] },
    migrations: { count: 1 },
    symbols: { present: ["GET", "POST", "createClient", "listOrders", "createOrder"] },
    calls: { present: [["GET", "createClient"], ["POST", "createClient"]] },
  },
};
