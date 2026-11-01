import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { requireDatabaseUrl } from "./env";
import { createDatabase } from "./index";

const { db, pool } = createDatabase(requireDatabaseUrl());
try {
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  console.log("Database migrations applied.");
} catch {
  console.error("Migration failed. Check the connection and migration SQL.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
