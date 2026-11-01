import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

export { sql } from "drizzle-orm";
export type Database = ReturnType<typeof createDatabase>["db"];

export function createDatabase(databaseUrl: string) {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
  pool.on("error", () =>
    console.error("Unexpected database pool connection error."),
  );
  return { db: drizzle({ client: pool, schema }), pool };
}
