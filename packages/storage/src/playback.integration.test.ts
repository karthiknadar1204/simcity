import { test, expect } from "bun:test";
import "@repo/db/env";
import { createDatabase } from "@repo/db";
import { WorldStore } from "./world-store";
import { PlaybackStore } from "./playback-store";
import { Playback } from "@repo/playback";
import { parseScenario, type Command, contentHash } from "@repo/contracts";
import scenario from "../../../experiments/scenarios/dev/town.json";
const live = process.env.RUN_INTEGRATION === "1" ? test : test.skip;
live(
  "time lookup returns committed animation segments and rejects requests beyond the frozen recorded range",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!),
      worlds = new WorldStore(db),
      owner = crypto.randomUUID();
    let runId = "";
    const execute = async (command: Command) =>
      worlds.execute(runId, owner, await worlds.claim(runId, owner), command);
    try {
      const input = parseScenario(scenario),
        citizen = input.citizens[0]!;
      runId = (await worlds.create(input, "recorded-time-fixture")).state.runId;
      await execute({
        id: "walk",
        action: {
          kind: "move",
          actorId: citizen.id,
          destination: { x: citizen.position.x + 1, y: citizen.position.y },
        },
      });
      await execute({
        id: "tick",
        action: { kind: "advance", durationMs: 400 },
      });
      const current = await worlds.current(runId);
      const store = new PlaybackStore(db),
        bundle = await store.bundle(
          runId,
          input.startTimeMs,
          input.startTimeMs + 400,
          current.state.sequence,
        ),
        playback = new Playback(bundle);
      expect(
        playback
          .frameAt(input.startTimeMs + 200)
          .actors.find((item) => item.id === citizen.id)!.x,
      ).toBe(citizen.position.x + 0.5);
      expect(await contentHash(playback.stateAt(input.startTimeMs + 400))).toBe(
        current.stateHash,
      );
      await expect(
        store.bundle(runId, input.startTimeMs, input.startTimeMs + 401),
      ).rejects.toThrow("recorded");
      console.log(`Time playback fixture ${runId}`);
    } finally {
      if (runId)
        await worlds.release(runId, owner, await worlds.claim(runId, owner));
      await pool.end();
    }
  },
  60000,
);
