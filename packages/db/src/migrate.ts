import type { PoolClient } from "pg";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { requireDatabaseUrl } from "./env";
import { createDatabase } from "./index";

const { pool } = createDatabase(requireDatabaseUrl());
let client: PoolClient | undefined;
try {
  client = await pool.connect();
  await migrate(drizzle({ client, schema }), {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  console.log("Database migrations applied.");
} catch {
  console.error("Migration failed. Check the connection and migration SQL.");
  process.exitCode = 1;
} finally {
  client?.release(true);
  await pool.end();
}
