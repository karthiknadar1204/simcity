import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  contentHash,
  parseCommand,
  agentPolicy,
  type AgentConfiguration,
} from "@repo/contracts";
import { citizenView } from "@repo/engine";
import {
  StoreError,
  ThinkingError,
  type WorldStore,
  type AgentStore,
  type MemoryStore,
  type MemoryWorkStore,
} from "@repo/storage";
import type { Coordinator } from "../world/coordinator";
import { loadScenarios } from "../services/scenarios";
import { runProvenance } from "../services/run-provenance";

function integer(
  value: string | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum)
    throw new StoreError("Invalid numeric boundary.", 400);
  return parsed;
}

export function worldRoutes(
  store: WorldStore | null,
  coordinator: Coordinator | null,
  cognition?: {
    agents: AgentStore;
    ready: boolean;
    defaultModel: string;
    memory?: MemoryStore;
    memoryWork?: MemoryWorkStore;
  },
) {
  const app = new Hono();
  const service = () => {
    if (!store || !coordinator)
      throw new StoreError(
        "Configure DATABASE_URL to use the world engine.",
        503,
      );
    return { store, coordinator };
  };
  const origins = new Set([
    process.env.WEB_ORIGIN || "http://localhost:5173",
    "http://127.0.0.1:5173",
  ]);
  app.use("*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const origin = c.req.header("Origin");
      if (origin && !origins.has(origin))
        return c.json(
          { error: "Origin is not allowed to control this world." },
          403,
        );
    }
    if (process.env.OPERATOR_TOKEN)
      return bearerAuth({ token: process.env.OPERATOR_TOKEN })(c, next);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ThinkingError)
      return c.json({ error: error.message }, 409);
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof StoreError)
      return c.json(
        { error: error.message },
        error.status as ContentfulStatusCode,
      );
    if (error instanceof SyntaxError || error.name === "ZodError")
      return c.json(
        { error: "Invalid request. Check the request shape and parameters." },
        400,
      );
    console.error("World request failed:", error.name);
    return c.json(
      { error: "World request failed. No successful effect was reported." },
      500,
    );
  });
  app.get("/scenarios", async (c) =>
    c.json({
      scenarios: (await loadScenarios()).map((s) => ({
        id: s.id,
        name: s.name,
        citizens: s.citizens.length,
        residents: s.citizens.map((citizen) => ({
          id: citizen.id,
          name: citizen.name,
        })),
        width: s.map.width,
        height: s.map.height,
      })),
    }),
  );
  app.get("/runs", async (c) => c.json({ runs: await service().store.list() }));
  app.post("/runs", async (c) => {
    const body = await c.req.json<{
      scenarioId?: string;
      autonomous?: boolean;
      citizenId?: string;
    }>();
    if (
      !body ||
      typeof body !== "object" ||
      typeof body.scenarioId !== "string" ||
      Object.keys(body).some(
        (key) => !["scenarioId", "autonomous", "citizenId"].includes(key),
      ) ||
      (body.autonomous !== undefined && typeof body.autonomous !== "boolean") ||
      (body.citizenId !== undefined && typeof body.citizenId !== "string")
    )
      throw new StoreError(
        "Supply a scenarioId and optional autonomous/citizenId fields.",
        400,
      );
    const scenario = (await loadScenarios()).find(
      (s) => s.id === body.scenarioId,
    );
    if (!scenario) throw new StoreError("Scenario not found.", 404);
    let agent: AgentConfiguration | undefined;
    if (body.autonomous) {
      if (!cognition?.ready)
        throw new StoreError(
          "Configure server-only OPENAI_API_KEY and REDIS_URL first.",
          503,
        );
      if (![agentPolicy.model, "gpt-5.4-mini"].includes(cognition.defaultModel))
        throw new StoreError(
          "Actor model has no verified pricing profile.",
          400,
        );
      agent = {
        provider: "openai",
        citizenId: body.citizenId || scenario.citizens[0]!.id,
        model: cognition.defaultModel,
        spendingLimitMicroUsd: agentPolicy.spendingLimitMicroUsd,
        maxRequests: agentPolicy.maxRequests,
        memory: true,
      };
    }
    const { revision, provenance } = await runProvenance(
      body.autonomous ? "phase-3" : "baseline",
    );
    return c.json(
      await service().store.create(scenario, revision, provenance, agent),
      201,
    );
  });
  app.get("/runs/:id/citizens/:citizenId/thinking", async (c) => {
    if (!cognition) return c.json({ thinking: null });
    await service().store.current(c.req.param("id"));
    return c.json({
      thinking: await cognition.agents.status(
        c.req.param("id"),
        c.req.param("citizenId"),
      ),
    });
  });
  app.get("/runs/:id/citizens/:citizenId/memories", async (c) => {
    const { state, manifest } = await service().store.current(
      c.req.param("id"),
    );
    const citizenId = c.req.param("citizenId");
    if (!state.citizens[citizenId])
      throw new StoreError("Citizen not found.", 404);
    if (!cognition?.memory)
      throw new StoreError("Memory store is not configured.", 503);
    const asOf = integer(c.req.query("asOf"), state.sequence, state.sequence);
    const query = (c.req.query("q") ?? "").slice(0, 200);
    return c.json({
      variant: manifest.memoryVariant,
      asOf,
      ...(await cognition.memory.inspect(state.runId, citizenId, asOf, query)),
      jobs:
        asOf === state.sequence
          ? ((await cognition.memoryWork?.status(state.runId, citizenId)) ?? [])
          : [],
    });
  });
  app.get("/runs/:id/citizens/:citizenId/memories/:sourceId", async (c) => {
    const { state } = await service().store.current(c.req.param("id"));
    if (!state.citizens[c.req.param("citizenId")])
      throw new StoreError("Citizen not found.", 404);
    const asOf = integer(c.req.query("asOf"), state.sequence, state.sequence);
    const source = await cognition?.memory?.read(
      state.runId,
      c.req.param("citizenId"),
      asOf,
      c.req.param("sourceId"),
    );
    if (!source)
      throw new StoreError(
        "No accessible personal memory at this boundary.",
        404,
      );
    return c.json(source);
  });
  app.post(
    "/runs/:id/citizens/:citizenId/memory-jobs/:taskId/retry",
    async (c) => {
      if (!cognition?.ready || !cognition.memoryWork)
        throw new StoreError("Memory runtime is not configured.", 503);
      const jobs = await cognition.memoryWork.status(
        c.req.param("id"),
        c.req.param("citizenId"),
      );
      if (
        !jobs.some(
          (job) =>
            job.task.id === c.req.param("taskId") && job.status === "failed",
        )
      )
        throw new StoreError(
          "Failed memory task not found for this citizen.",
          404,
        );
      return c.json({
        taskId: await cognition.memoryWork.retry(c.req.param("taskId")),
        status: "scheduled",
      });
    },
  );
  app.post("/runs/:id/citizens/:citizenId/retry", async (c) => {
    if (!cognition?.ready)
      throw new StoreError("Autonomous runtime is not configured.", 503);
    await cognition.agents.retry(c.req.param("id"), c.req.param("citizenId"));
    return c.json({ status: "scheduled" });
  });
  app.get("/runs/:id", async (c) =>
    c.json(await service().store.current(c.req.param("id"))),
  );
  app.post("/runs/:id/commands", async (c) =>
    c.json(
      await service().coordinator.execute(
        c.req.param("id"),
        parseCommand(await c.req.json()),
      ),
    ),
  );
  app.get("/runs/:id/events", async (c) =>
    c.json({
      events: await service().store.history(
        c.req.param("id"),
        integer(c.req.query("after"), 0),
        integer(c.req.query("limit"), 100, 500),
      ),
    }),
  );
  app.get("/runs/:id/replay", async (c) => {
    const { store } = service();
    const current = await store.current(c.req.param("id"));
    const boundary = integer(
      c.req.query("sequence"),
      current.state.sequence,
      current.state.sequence,
    );
    const state = await store.atSequence(c.req.param("id"), boundary);
    return c.json({
      state,
      stateHash: await contentHash(state),
      readOnly: true,
    });
  });
  app.get("/runs/:id/citizens/:citizenId/view", async (c) => {
    const { state } = await service().store.current(c.req.param("id"));
    if (!Object.hasOwn(state.citizens, c.req.param("citizenId")))
      throw new StoreError("Citizen not found.", 404);
    return c.json(citizenView(state, c.req.param("citizenId")));
  });
  app.get("/runs/:id/citizens/:citizenId/observations", async (c) =>
    c.json({
      observations: await service().store.personalObservations(
        c.req.param("id"),
        c.req.param("citizenId"),
        integer(c.req.query("limit"), 50, 200),
        integer(c.req.query("before"), Number.MAX_SAFE_INTEGER),
      ),
    }),
  );
  app.get("/runs/:id/stream", async (c) => {
    const { store } = service();
    await store.current(c.req.param("id"));
    return streamSSE(
      c,
      async (stream) => {
        let sequence = -1;
        let keepAliveAt = Date.now();
        while (!stream.aborted) {
          const { state } = await store.current(c.req.param("id"));
          if (state.sequence !== sequence) {
            await stream.writeSSE({
              event: "world",
              id: String(state.sequence),
              data: JSON.stringify(state),
            });
            sequence = state.sequence;
            keepAliveAt = Date.now();
          } else if (Date.now() - keepAliveAt >= 5000) {
            await stream.writeSSE({ event: "heartbeat", data: "ping" });
            keepAliveAt = Date.now();
          }
          await stream.sleep(500);
        }
      },
      async () => {
        console.error(
          "Live world stream interrupted; the browser can reconnect.",
        );
      },
    );
  });
  return app;
}
