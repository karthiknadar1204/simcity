import { requireDatabaseUrl } from "./env";
import { createDatabase, sql } from "./index";

const { db, pool } = createDatabase(requireDatabaseUrl());
try {
  await db.execute(sql`select 1`);
  console.log("Neon PostgreSQL connection verified through Drizzle.");
} catch {
  console.error(
    "Database connection failed. Check DATABASE_URL and network access.",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
