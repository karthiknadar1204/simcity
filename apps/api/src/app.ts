import { Hono } from "hono";
import { cors } from "hono/cors";
import { createDatabase, sql } from "@repo/db";

export function createApp(databaseUrl?: string) {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const app = new Hono();

  app.use(
    "/api/*",
    cors({ origin: process.env.WEB_ORIGIN || "http://localhost:5173" }),
  );
  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      service: "simcity-api",
      databaseConfigured: Boolean(database),
    }),
  );
  app.get("/api/health/db", async (c) => {
    if (!database)
      return c.json(
        {
          status: "unconfigured",
          message: "Set DATABASE_URL in the root .env file.",
        },
        503,
      );
    try {
      await database.db.execute(sql`select 1`);
      return c.json({ status: "ok", database: "postgresql" });
    } catch {
      return c.json(
        { status: "unavailable", message: "Database connection failed." },
        503,
      );
    }
  });

  return {
    app,
    close: async () => {
      await database?.pool.end();
    },
  };
}
