import { test, expect } from "bun:test";
import "@repo/db/env";
import { createDatabase } from "@repo/db";
import { agentPolicy, parseScenario } from "@repo/contracts";
import { WorldStore } from "./world-store";
import { MemoryStore } from "./memory-store";
import scenario from "../../../experiments/scenarios/dev/town.json";
const live = process.env.RUN_INTEGRATION === "1" ? test : test.skip;

live(
  "raw episodes are immediately searchable, versioned, scoped, idempotent, and replay-safe before indexing",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const worlds = new WorldStore(db),
      memory = new MemoryStore(db),
      owner = crypto.randomUUID();
    let runId = "";
    try {
      const input = parseScenario(scenario),
        self = input.citizens[0]!,
        peer = input.citizens[1]!;
      peer.position = { x: self.position.x + 1, y: self.position.y };
      const created = await worlds.create(
        input,
        "memory-storage-fixture",
        undefined,
        {
          provider: "fixture",
          citizenId: self.id,
          model: agentPolicy.model,
          spendingLimitMicroUsd: 100000,
          maxRequests: 20,
          memory: true,
        },
      );
      runId = created.state.runId;
      const generation = await worlds.claim(runId, owner);
      const first = await worlds.execute(runId, owner, generation, {
        id: "offer",
        action: {
          kind: "say",
          actorId: self.id,
          audienceIds: [peer.id],
          text: "I will bring six food by 18:00.",
        },
      });
      const second = await worlds.execute(runId, owner, generation, {
        id: "accept",
        action: {
          kind: "say",
          actorId: peer.id,
          audienceIds: [self.id],
          text: "Agreed.",
        },
      });
      const found = await memory.search(
        runId,
        self.id,
        second.state.sequence,
        "six food",
      );
      expect(found.mode).toBe("text");
      expect(found.pendingIndexes).toBeGreaterThan(0);
      const episode = found.candidates.find((item) =>
        item.memory.text.includes("Agreed."),
      )!.memory;
      expect(episode.version).toBe(2);
      expect(episode.sourceIds.length).toBe(2);
      const earlier = await memory.list(runId, self.id, first.state.sequence);
      expect(earlier.some((item) => item.text.includes("Agreed."))).toBeFalse();
      expect(
        earlier.find((item) => item.logicalId === episode.logicalId)!.version,
      ).toBe(1);
      expect(
        await memory.read(runId, peer.id, second.state.sequence, episode.id),
      ).toBeNull();
      expect(
        await memory.read(runId, self.id, first.state.sequence, episode.id),
      ).toBeNull();
      await worlds.execute(runId, owner, generation, {
        id: "accept",
        action: {
          kind: "say",
          actorId: peer.id,
          audienceIds: [self.id],
          text: "Agreed.",
        },
      });
      expect(
        (await memory.list(runId, self.id, second.state.sequence)).filter(
          (item) => item.logicalId === episode.logicalId,
        ).length,
      ).toBe(1);
      expect((await worlds.load(runId)).stateHash).toBe(
        (await worlds.current(runId)).stateHash,
      );
      console.log(`Memory storage fixture ${runId}`);
    } finally {
      if (runId) {
        const generation = await worlds.claim(runId, owner);
        await worlds.release(runId, owner, generation);
      }
      await pool.end();
    }
  },
  60000,
);
