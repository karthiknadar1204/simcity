import { backgroundTasks } from "@repo/db/tables";
import { eq } from "drizzle-orm";
import { test, expect } from "bun:test";
import "@repo/db/env";
import { createDatabase } from "@repo/db";
import { WorldStore } from "./world-store";
import { RecordingStore } from "./recording-store";
import { createArchiveStore } from "./r2";
import { Playback } from "@repo/playback";
import { parseScenario, contentHash, type Command } from "@repo/contracts";
import scenario from "../../../experiments/scenarios/dev/town.json";
const live = process.env.RUN_INTEGRATION === "1" ? test : test.skip;
live(
  "an R2 recording publishes only after verified upload and replays the exact checkpoint",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!),
      worlds = new WorldStore(db),
      archive = createArchiveStore()!,
      store = new RecordingStore(db),
      owner = crypto.randomUUID();
    let runId = "";
    const execute = async (command: Command) =>
      worlds.execute(runId, owner, await worlds.claim(runId, owner), command);
    try {
      const input = parseScenario(scenario),
        citizen = input.citizens[0]!;
      runId = (await worlds.create(input, "r2-recording-fixture")).state.runId;
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
      await execute({
        id: "checkpoint",
        action: { kind: "set-status", status: "paused" },
      });
      const current = await worlds.current(runId),
        id = await store.queueExisting(runId, current.state.sequence),
        rows = await store.list(runId),
        row = rows.find((row) => row.chunk.id === id)!;
      expect(row.chunk.manifest).toBeNull();
      await db
        .update(backgroundTasks)
        .set({
          status: "failed",
          attempts: 5,
          error: "fixture archive failure",
        })
        .where(eq(backgroundTasks.id, id));
      expect(await store.queueExisting(runId, current.state.sequence)).toBe(id);
      expect(
        (await store.list(runId)).find((row) => row.chunk.id === id)?.status,
      ).toBe("pending");
      const payload = {
        runId,
        fromSequence: row.chunk.fromSequence,
        toSequence: row.chunk.toSequence,
      };
      const manifest = await store.publish(id, payload, archive);
      expect(manifest.bytes).toBeGreaterThan(0);
      await db
        .update(backgroundTasks)
        .set({ status: "queued" })
        .where(eq(backgroundTasks.id, id));
      expect(await store.publish(id, payload, archive)).toEqual(manifest);
      const source = await store.read(runId, id, archive);
      expect(
        await contentHash(
          new Playback(source.bundle).stateAt(source.bundle.toMs),
        ),
      ).toBe(current.stateHash);
      await expect(
        archive.read(manifest.key, "invalid", manifest.bytes),
      ).rejects.toThrow("checksum");
      expect(
        (await store.list(runId)).find((row) => row.chunk.id === id)?.status,
      ).toBe("completed");
      console.log(
        `R2 recording fixture ${runId}, ${manifest.bytes} verified bytes`,
      );
    } finally {
      if (runId)
        await worlds.release(runId, owner, await worlds.claim(runId, owner));
      archive.close();
      await pool.end();
    }
  },
  60000,
);
