import { test, expect } from "bun:test";
import "@repo/db/env";
import { createDatabase } from "@repo/db";
import { WorldStore } from "./world-store";
import { MediaStore } from "./media-store";
import { parseScenario, type VideoRequest } from "@repo/contracts";
import scenario from "../../../experiments/scenarios/dev/town.json";
const live = process.env.RUN_INTEGRATION === "1" ? test : test.skip;
live(
  "an export freezes a recorded boundary, deduplicates requests, rejects future time and never changes the world",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!),
      worlds = new WorldStore(db),
      owner = crypto.randomUUID();
    let runId = "";
    try {
      const input = parseScenario(scenario);
      runId = (await worlds.create(input, "media-storage-fixture")).state.runId;
      await worlds.execute(runId, owner, await worlds.claim(runId, owner), {
        id: "tick",
        action: { kind: "advance", durationMs: 2000 },
      });
      const before = await worlds.current(runId),
        store = new MediaStore(db);
      const request: VideoRequest = {
        startMs: input.startTimeMs,
        endMs: input.startTimeMs + 2000,
        speed: 1,
        width: 1280,
        height: 720,
        fps: 30,
        camera: { x: 384, y: 256, zoom: 1.2 },
      };
      const id = await store.create(runId, request);
      expect(await store.create(runId, request)).toBe(id);
      await expect(
        store.create(runId, { ...request, endMs: input.startTimeMs + 2001 }),
      ).rejects.toThrow("recorded");
      expect((await worlds.current(runId)).stateHash).toBe(before.stateHash);
      console.log(`Media storage fixture ${runId}`);
    } finally {
      if (runId)
        await worlds.release(runId, owner, await worlds.claim(runId, owner));
      await pool.end();
    }
  },
  60000,
);
