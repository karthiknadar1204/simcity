import { WorldStore } from "@repo/storage";
import { Coordinator } from "./world/coordinator";
import { worldRoutes } from "./routes/worlds";
import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { createDatabase, sql } from "@repo/db";

export function createApp(databaseUrl?: string) {
  const database = databaseUrl ? createDatabase(databaseUrl) : null;
  const app = new Hono();
  const store = database ? new WorldStore(database.db) : null;
  const coordinator = store ? new Coordinator(store) : null;
  app.use("/api/*", bodyLimit({ maxSize: 1024 * 1024 }));

  app.use(
    "/api/*",
    cors({ origin: process.env.WEB_ORIGIN || "http://localhost:5173" }),
  );
  app.route("/api/world", worldRoutes(store, coordinator));
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
    start: async () => {
      await coordinator?.start();
    },
    close: async () => {
      await coordinator?.stop();
      await database?.pool.end();
    },
  };
}
