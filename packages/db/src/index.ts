import WebSocket from "ws";
import { Pool, neonConfig, type PoolClient } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

export { sql } from "drizzle-orm";
export type Database = ReturnType<typeof createDatabase>["db"];

neonConfig.webSocketConstructor = WebSocket;

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
  const db = drizzle({ client: pool, schema });
  // Own the lease outside Drizzle's BEGIN. Its Neon adapter starts BEGIN before
  // its try/finally, so a lost BEGIN acknowledgement otherwise leaks a client.
  db.transaction = async (callback, config) => {
    const client = await pool.connect();
    let failed = true;
    try {
      const session = drizzle({ client, schema });
      const result = await session.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('statement_timeout','7s',true),set_config('idle_in_transaction_session_timeout','10s',true)`,
        );
        return callback(tx);
      }, config);
      failed = false;
      return result;
    } finally {
      client.release(failed);
    }
  };
  return { db, pool };
}
