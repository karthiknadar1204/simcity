import { Pool, type PoolClient } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

export { sql } from "drizzle-orm";
export type Database = ReturnType<typeof createDatabase>["db"];

export function createDatabase(
  databaseUrl: string,
  options: { max?: number } = {},
) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: options.max ?? 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 7_000,
    query_timeout: 8_000,
    idle_in_transaction_session_timeout: 10_000,
  });
  pool.on("connect", (client: PoolClient) => {
    client.on("error", () =>
      console.error(
        "A database session disconnected; affected work will fail and retry from durable state.",
      ),
    );
  });
  pool.on("error", () =>
    console.error("Unexpected database pool connection error."),
  );
  return { db: drizzle({ client: pool, schema }), pool };
}
