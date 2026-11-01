import {
  WorldStore,
  AgentStore,
  MemoryStore,
  MemoryWorkStore,
} from "@repo/storage";
import {
  AgentRunner,
  AgentRuntime,
  createOpenAIModel,
  createOpenAIMemoryModel,
  MemoryRunner,
  MemoryRuntime,
  MemoryQueries,
  ContextCompiler,
} from "@repo/agent-runtime";
import { agentPolicy } from "@repo/contracts";
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
  const agents = database ? new AgentStore(database.db) : null;
  const apiKey = process.env.OPENAI_API_KEY || process.env.openai_api_key;
  const ready = Boolean(
    apiKey && process.env.REDIS_URL && store && coordinator && agents,
  );
  const defaultModel = process.env.OPENAI_MODEL || agentPolicy.model;
  const memory = database ? new MemoryStore(database.db) : null;
  const memoryWork = database ? new MemoryWorkStore(database.db) : null;
  const memoryModel = apiKey ? createOpenAIMemoryModel(apiKey) : null;
  const queries =
    memory && memoryWork && memoryModel
      ? new MemoryQueries(memory, memoryWork, memoryModel)
      : null;
  const compiler =
    memory && queries ? new ContextCompiler(memory, queries) : null;
  const memoryRuntime =
    ready && memory && memoryWork && memoryModel
      ? new MemoryRuntime(
          memoryWork,
          new MemoryRunner(memory, memoryWork, memoryModel),
          process.env.REDIS_URL!,
        )
      : null;
  const runtime =
    ready && store && coordinator && agents
      ? new AgentRuntime(
          agents,
          new AgentRunner(
            store,
            agents,
            coordinator,
            (model) => createOpenAIModel(apiKey!, model),
            compiler ?? undefined,
            queries ?? undefined,
          ),
          process.env.REDIS_URL!,
        )
      : null;
  app.use("/api/*", bodyLimit({ maxSize: 1024 * 1024 }));

  app.use(
    "/api/*",
    cors({ origin: process.env.WEB_ORIGIN || "http://localhost:5173" }),
  );
  app.route(
    "/api/world",
    worldRoutes(
      store,
      coordinator,
      agents
        ? {
            agents,
            ready,
            defaultModel,
            memory: memory!,
            memoryWork: memoryWork!,
          }
        : undefined,
    ),
  );
  app.get("/api/health", (c) =>
    c.json({
      status: "ok",
      service: "simcity-api",
      databaseConfigured: Boolean(database),
      autonomousConfigured: ready,
      actorModel: ready ? defaultModel : null,
      memoryConfigured: Boolean(memoryRuntime),
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
      await memoryRuntime?.start();
      await runtime?.start();
    },
    close: async () => {
      await runtime?.close();
      await memoryRuntime?.close();
      await coordinator?.stop();
      await database?.pool.end();
    },
  };
}
