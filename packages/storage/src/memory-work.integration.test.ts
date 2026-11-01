import { test, expect } from "bun:test";
import "@repo/db/env";
import { createDatabase } from "@repo/db";
import { and, desc, eq } from "drizzle-orm";
import {
  memoryTasks,
  memories,
  memoryCalls,
  agentBudgets,
} from "@repo/db/tables";
import {
  agentPolicy,
  memoryPolicy,
  parseScenario,
  type MemoryCallRequest,
} from "@repo/contracts";
import { WorldStore } from "./world-store";
import { MemoryWorkStore } from "./memory-work-store";
import scenario from "../../../experiments/scenarios/dev/town.json";
const live = process.env.RUN_INTEGRATION === "1" ? test : test.skip;
live(
  "memory task claims and model reservations survive worker replacement without duplicate charges",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const worlds = new WorldStore(db),
      jobs = new MemoryWorkStore(db),
      owner = crypto.randomUUID();
    let runId = "";
    try {
      const input = parseScenario(scenario),
        self = input.citizens[0]!;
      const created = await worlds.create(
        input,
        "memory-work-fixture",
        undefined,
        {
          provider: "fixture",
          citizenId: self.id,
          model: agentPolicy.model,
          maxRequests: 8,
          spendingLimitMicroUsd: 100000,
          memory: true,
        },
      );
      runId = created.state.runId;
      const [task] = await db
        .select({ id: memoryTasks.id })
        .from(memoryTasks)
        .innerJoin(memories, eq(memories.id, memoryTasks.memoryId))
        .where(
          and(eq(memories.runId, runId), eq(memoryTasks.operation, "embed")),
        )
        .orderBy(desc(memoryTasks.cutoff))
        .limit(1);
      const first = (await jobs.begin(task!.id, "first-worker", true))!;
      expect(first).not.toBeNull();
      expect(await jobs.begin(task!.id, "other-worker", true)).toBeNull();
      const request: MemoryCallRequest = {
        kind: "embed",
        model: memoryPolicy.embeddingModel,
        instructions: "",
        input: "A personal seed memory",
        inputTokens: 10,
      };
      await Promise.all([
        jobs.reserveCall(runId, self.id, first.guard, "main", request),
        jobs.reserveCall(runId, self.id, first.guard, "main", request),
      ]);
      expect(
        (
          await db
            .select()
            .from(memoryCalls)
            .where(eq(memoryCalls.taskId, task!.id))
        ).length,
      ).toBe(1);
      const [reserved] = await db
        .select()
        .from(agentBudgets)
        .where(eq(agentBudgets.runId, runId));
      expect(reserved!.requests).toBe(1);
      await jobs.saveAnswer(runId, first.guard, "main", {
        model: memoryPolicy.embeddingModel,
        data: Array.from({ length: memoryPolicy.dimensions }, (_, index) =>
          index === 0 ? 1 : 0,
        ),
        inputTokens: 10,
        outputTokens: 0,
        cachedTokens: 0,
      });
      await jobs.release(first.guard);
      const next = (await jobs.begin(task!.id, "replacement-worker", true))!;
      expect(next.guard.generation).toBeGreaterThan(first.guard.generation);
      await jobs.reserveCall(runId, self.id, next.guard, "main", request);
      const [after] = await db
        .select()
        .from(agentBudgets)
        .where(eq(agentBudgets.runId, runId));
      expect(after!.requests).toBe(1);
      expect(after!.reservedMicroUsd).toBe(0);
      await jobs.release(next.guard);
      console.log(`Memory work fixture ${runId}`);
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
