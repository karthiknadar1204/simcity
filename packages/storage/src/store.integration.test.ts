import { expect, test } from "bun:test";
import "@repo/db/env";
import { createDatabase } from "@repo/db";
import { WorldStore } from "./index";
import { parseScenario, contentHash } from "@repo/contracts";
import scenario from "../../../experiments/scenarios/dev/town.json";

const live = process.env.RUN_INTEGRATION === "1" ? test : test.skip;
live(
  "Neon commits transfers once, fences stale owners, and recovers the same world",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    try {
      const store = new WorldStore(db);
      const input = parseScenario(scenario);
      const [a, b] = input.citizens;
      b!.position = { x: a!.position.x + 1, y: a!.position.y };
      const created = await store.create(input, "integration-fixture");
      const runId = created.state.runId;
      const generation = await store.claim(runId, "integration-owner");
      const command = {
        id: "transfer-proof",
        action: {
          kind: "transfer" as const,
          actorId: a!.id,
          targetId: b!.id,
          resource: "food",
          amount: 1,
        },
      };
      const first = await store.execute(
        runId,
        "integration-owner",
        generation,
        command,
      );
      const retry = await store.execute(
        runId,
        "integration-owner",
        generation,
        command,
      );
      expect(retry.state.sequence).toBe(first.state.sequence);
      expect(retry.state.citizens[b!.id]!.inventory.food).toBe(3);
      expect(await store.personalObservations(runId, a!.id, 50, 0)).toEqual([]);
      const nextGeneration = await store.claim(runId, "integration-owner");
      expect(nextGeneration).toBeGreaterThan(generation);
      await expect(
        store.execute(runId, "integration-owner", generation, {
          id: "stale",
          action: { kind: "advance", durationMs: 1000 },
        }),
      ).rejects.toThrow("ownership");
      const recovered = await new WorldStore(db).load(runId);
      expect(await contentHash(recovered.state)).toBe(
        await contentHash(first.state),
      );
      console.log(`Verified isolated fixture run ${runId}`);
    } finally {
      await pool.end();
    }
  },
  30000,
);
