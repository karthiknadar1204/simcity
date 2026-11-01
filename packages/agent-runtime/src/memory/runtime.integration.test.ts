// Real Neon + Redis, explicitly scripted provider output. This proves delivery,
// evidence boundaries and recovery; it does not claim autonomous behavior.
import { test, expect } from "bun:test";
import "@repo/db/env";
import { createDatabase } from "@repo/db";
import { createMemoryQueue } from "@repo/jobs";
import { WorldStore, MemoryStore, MemoryWorkStore } from "@repo/storage";
import {
  agentPolicy,
  memoryPolicy,
  parseScenario,
  type Command,
  type MemoryExtraction,
  type MemorySource,
} from "@repo/contracts";
import scenario from "../../../../experiments/scenarios/dev/town.json";
import { MemoryRunner } from "./runner";
import { MemoryRuntime } from "./runtime";
import type { MemoryModel } from "./openai";
const live = process.env.RUN_INTEGRATION === "1" ? test : test.skip;

live(
  "SQL outbox replaces lost Redis delivery, sleep uses a fixed cutoff, and worker restart does not repeat inference",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const worlds = new WorldStore(db),
      memory = new MemoryStore(db),
      work = new MemoryWorkStore(db),
      owner = crypto.randomUUID();
    let runId = "",
      runtime: MemoryRuntime | undefined,
      calls = 0;
    const execute = async (command: Command) =>
      worlds.execute(runId, owner, await worlds.claim(runId, owner), command);
    try {
      const input = parseScenario(scenario),
        self = input.citizens[0]!,
        peer = input.citizens[1]!;
      self.initialMemories = [];
      peer.position = { x: self.position.x + 1, y: self.position.y };
      runId = (
        await worlds.create(input, "memory-queue-provider-fixture", undefined, {
          provider: "fixture",
          citizenId: self.id,
          model: agentPolicy.model,
          maxRequests: 40,
          spendingLimitMicroUsd: 200000,
          memory: true,
        })
      ).state.runId;
      await execute({
        id: "experience",
        action: {
          kind: "say",
          actorId: peer.id,
          audienceIds: [self.id],
          text: "The garden was pleasant this morning.",
        },
      });
      const sleeping = await execute({
        id: "sleep",
        action: {
          kind: "sleep",
          actorId: self.id,
          targetId: input.objects.find(
            (object) =>
              object.tags.includes("bed") && object.ownerId === self.id,
          )!.id,
          durationMs: 28800000,
        },
      });
      expect(sleeping.receipt.status).toBe("accepted");
      const cutoff = sleeping.state.sequence,
        sleepJob = sleeping.state.citizens[self.id]!.actionId!;
      const queueName = `memory-fixture-${runId}`;
      const lost = createMemoryQueue(process.env.REDIS_URL!, queueName);
      const pending = await work.candidates(true, runId);
      for (const task of pending)
        await lost.add("memory.work", { taskId: task.id }, { jobId: task.id });
      await lost.obliterate({ force: true });
      await lost.close();
      const model: MemoryModel = {
        async respond(request) {
          calls++;
          if (request.kind === "embed")
            return {
              model: memoryPolicy.embeddingModel,
              data: Array.from({ length: 512 }, (_, index) =>
                index === 0 ? 1 : 0,
              ),
              inputTokens: 20,
              cachedTokens: 0,
              outputTokens: 0,
            };
          const data = JSON.parse(request.input) as {
            sources: MemorySource[];
            sourceCutoff: number;
          };
          expect(
            data.sources.every(
              (source) => source.sequence <= data.sourceCutoff,
            ),
          ).toBeTrue();
          if (request.kind === "consolidate")
            expect(data.sourceCutoff).toBe(cutoff);
          const source = data.sources[0]!;
          const extraction: MemoryExtraction = {
            title:
              request.kind === "consolidate"
                ? "Qualified sleep reflection"
                : "Conversation episode",
            summary:
              "A personally received experience was recorded; its original source remains available.",
            summaryEvidence: [{ sourceId: source.id, quote: source.content }],
            agreements: [],
            claims: [],
          };
          return {
            model: memoryPolicy.extractionModel,
            data: extraction,
            inputTokens: 100,
            cachedTokens: 0,
            outputTokens: 80,
          };
        },
      };
      const start = async () => {
        const host = new MemoryRuntime(
          work,
          new MemoryRunner(memory, work, model, true),
          process.env.REDIS_URL!,
          queueName,
          runId,
        );
        await host.start();
        return host;
      };
      runtime = await start();
      const end = Date.now() + 90000;
      while (Date.now() < end) {
        const jobs = await work.status(runId, self.id);
        if (
          jobs.length &&
          jobs.every(
            (job) => !["pending", "queued", "running"].includes(job.status),
          )
        )
          break;
        await Bun.sleep(500);
      }
      expect(await work.candidates(true, runId)).toEqual([]);
      const tasks = await work.status(runId, self.id);
      console.log(
        `Memory queue statuses ${runId}`,
        tasks.map((job) => ({
          operation: job.task.operation,
          status: job.status,
          error: job.error,
          outcome: job.task.outcome,
        })),
      );
      expect(tasks.every((task) => task.status === "completed")).toBeTrue();
      const stream = await memory.stream(runId, self.id);
      expect(stream!.consolidatedCutoff).toBe(cutoff);
      const current = (await worlds.current(runId)).state;
      expect(current.simTimeMs).toBe(sleeping.state.simTimeMs);
      expect(current.citizens[self.id]!.actionId).toBe(sleepJob);
      const reflection = (
        await memory.list(runId, self.id, current.sequence)
      ).find((item) => item.kind === "reflection")!;
      expect(reflection).toBeDefined();
      expect(
        await memory.read(runId, self.id, cutoff, reflection.id),
      ).toBeNull();
      expect((await worlds.load(runId)).stateHash).toBe(
        (await worlds.current(runId)).stateHash,
      );
      await runtime.close();
      runtime = await start();
      const before = calls;
      await Bun.sleep(1500);
      expect(calls).toBe(before);
      const saved = (await work.status(runId, self.id))
        .flatMap((job) => job.calls)
        .filter((call) => call.status === "responded");
      expect(saved.length).toBe(calls);
      console.log(
        `Memory queue fixture ${runId}: ${calls} scripted calls, cutoff ${cutoff}`,
      );
    } finally {
      await runtime?.close();
      if (runId)
        await worlds.release(runId, owner, await worlds.claim(runId, owner));
      await pool.end();
    }
  },
  120000,
);
