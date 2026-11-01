import { test, expect } from "bun:test";
import "@repo/db/env";
import { createDatabase } from "@repo/db";
import { eq } from "drizzle-orm";
import { agentControls } from "@repo/db/tables";
import { agentPolicy, parseScenario } from "@repo/contracts";
import { WorldStore } from "./world-store";
import { AgentStore } from "./agent-store";
import scenario from "../../../experiments/scenarios/dev/town.json";
const live = process.env.RUN_INTEGRATION === "1" ? test : test.skip;
live(
  "thinking is durable, single-owner, and fenced when new personal evidence arrives",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    try {
      const worlds = new WorldStore(db);
      const agents = new AgentStore(db);
      const input = parseScenario(scenario);
      const actor = input.citizens[0]!;
      const other = input.citizens[1]!;
      other.position = { x: actor.position.x + 1, y: actor.position.y };
      const created = await worlds.create(
        input,
        "agent-storage-fixture",
        undefined,
        {
          provider: "fixture",
          citizenId: actor.id,
          model: agentPolicy.model,
          spendingLimitMicroUsd: 50000,
          maxRequests: 3,
        },
      );
      const id = created.state.runId;
      const generation = await worlds.claim(id, "world-owner");
      await worlds.execute(id, "world-owner", generation, {
        id: "start",
        action: { kind: "set-status", status: "running" },
      });
      await worlds.execute(id, "world-owner", generation, {
        id: "step",
        action: { kind: "advance", durationMs: 1000 },
      });
      const [control] = await db
        .select()
        .from(agentControls)
        .where(eq(agentControls.runId, id));
      const claim = await agents.begin(control!.taskId!, "worker-a");
      expect(claim?.guard.generation).toBeGreaterThan(0);
      expect(await agents.begin(control!.taskId!, "worker-b")).toBeNull();
      const guard = claim!.guard;
      const request = {
        instructions: "fixture",
        context: "{}",
        history: [],
        inputTokens: 20,
      };
      await Promise.all([
        agents.reserveRound(id, guard, 0, request),
        agents.reserveRound(id, guard, 0, request),
      ]);
      expect((await agents.rounds(guard.taskId)).length).toBe(1);
      await agents.reserveRound(id, guard, 1, request);
      await agents.reserveRound(id, guard, 2, request);
      await expect(agents.reserveRound(id, guard, 3, request)).rejects.toThrow(
        "budget",
      );
      await worlds.execute(id, "world-owner", generation, {
        id: "new-message",
        action: {
          kind: "say",
          actorId: other.id,
          text: "A nearby route has changed.",
          audienceIds: [actor.id],
        },
      });
      const [changed] = await db
        .select()
        .from(agentControls)
        .where(eq(agentControls.runId, id));
      expect(changed!.version).toBeGreaterThan(guard.version);
      await expect(
        worlds.execute(
          id,
          "world-owner",
          generation,
          {
            id: "stale-model-action",
            action: { kind: "wait", actorId: actor.id, durationMs: 1000 },
          },
          guard,
        ),
      ).rejects.toThrow("superseded");
      expect(
        await agents.readEvidence(
          id,
          input.citizens[2]!.id,
          1000,
          `1-${actor.id}`,
        ),
      ).toBeNull();
      await worlds.execute(id, "world-owner", generation, {
        id: "pause-after-fixture",
        action: { kind: "set-status", status: "paused" },
      });
      console.log(`Durable thinking fixture ${id}`);
    } finally {
      await pool.end();
    }
  },
  30000,
);
