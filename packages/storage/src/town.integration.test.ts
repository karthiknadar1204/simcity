import { test, expect } from "bun:test";
import "@repo/db/env";
import { createDatabase } from "@repo/db";
import { agentPolicy, parseScenario, type Command } from "@repo/contracts";
import { WorldStore } from "./world-store";
import { AgentStore } from "./agent-store";
import { MemoryStore } from "./memory-store";
import scenario from "../../../experiments/scenarios/dev/town.json";
const live = process.env.RUN_INTEGRATION === "1" ? test : test.skip;
live(
  "three durable citizen controls have independent private memories and preserve sleep across store replacement",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const worlds = new WorldStore(db),
      agents = new AgentStore(db),
      memory = new MemoryStore(db),
      owner = crypto.randomUUID();
    let runId = "";
    const execute = async (command: Command) =>
      worlds.execute(runId, owner, await worlds.claim(runId, owner), command);
    try {
      const input = parseScenario(scenario);
      input.citizens.forEach((citizen, index) => {
        citizen.initialMemories = [`PRIVATE_CITIZEN_${index}`];
      });
      const [a, b, c] = input.citizens;
      b!.position = { x: a!.position.x + 1, y: a!.position.y };
      const created = await worlds.create(
        input,
        "three-citizen-provider-fixture",
        undefined,
        input.citizens.map((citizen) => ({
          provider: "fixture" as const,
          citizenId: citizen.id,
          model: agentPolicy.model,
          maxRequests: 20,
          spendingLimitMicroUsd: 100000,
          memory: true,
        })),
      );
      runId = created.state.runId;
      expect(created.manifest.agents).toHaveLength(3);
      const controls = await Promise.all(
        input.citizens.map((citizen) => agents.status(runId, citizen.id)),
      );
      expect(new Set(controls.map((row) => row!.control.taskId)).size).toBe(3);
      for (const [index, citizen] of input.citizens.entries()) {
        const seed = await memory.read(runId, citizen.id, 0, "seed-0");
        expect(JSON.stringify(seed)).toContain(`PRIVATE_CITIZEN_${index}`);
        expect(JSON.stringify(seed)).not.toContain(
          `PRIVATE_CITIZEN_${(index + 1) % 3}`,
        );
      }
      await execute({
        id: "talk",
        action: {
          kind: "conversation-start",
          actorId: a!.id,
          targetId: b!.id,
          text: "Would you like to talk?",
        },
      });
      const state = (await worlds.current(runId)).state;
      const own = (await memory.sources(runId, a!.id, state.sequence)).find(
        (source) => source.kind === "speech.delivered",
      )!;
      expect(
        (await memory.sources(runId, b!.id, state.sequence)).some(
          (source) => source.kind === "speech.delivered",
        ),
      ).toBeTrue();
      expect(
        await memory.read(runId, c!.id, state.sequence, own.id),
      ).toBeNull();
      const convo = Object.values(state.conversations!)[0]!;
      await execute({
        id: "decline",
        action: {
          kind: "conversation-end",
          actorId: b!.id,
          conversationId: convo.id,
          expectedVersion: convo.version,
          reason: "I need to rest",
        },
      });
      const sleep = await execute({
        id: "bed",
        action: {
          kind: "sleep",
          actorId: a!.id,
          targetId: input.objects.find(
            (object) => object.ownerId === a!.id && object.tags.includes("bed"),
          )!.id,
          durationMs: 28800000,
        },
      });
      const jobId = sleep.state.citizens[a!.id]!.actionId!;
      const restored = await new WorldStore(db).load(runId);
      expect(restored.state.jobs[jobId]).toEqual(sleep.state.jobs[jobId]);
      expect(restored.stateHash).toBe((await worlds.current(runId)).stateHash);
      await execute({
        id: "fixture-running",
        action: { kind: "set-status", status: "running" },
      });
      await worlds.release(runId, owner, await worlds.claim(runId, owner));
      expect(
        (await worlds.recoverableRuns()).some((row) => row.id === runId),
      ).toBeFalse();
      expect(
        (await worlds.recoverableRuns(true)).some((row) => row.id === runId),
      ).toBeTrue();
      await execute({
        id: "fixture-paused",
        action: { kind: "set-status", status: "paused" },
      });
      console.log(`Three citizen fixture ${runId}`);
    } finally {
      if (runId)
        await worlds.release(runId, owner, await worlds.claim(runId, owner));
      await pool.end();
    }
  },
  60000,
);
