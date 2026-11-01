// Scripted provider fixture, real SQL and concurrent independent thinking.
import { test, expect } from "bun:test";
import "@repo/db/env";
import { createDatabase } from "@repo/db";
import { AgentStore, WorldStore } from "@repo/storage";
import { AgentRunner } from "@repo/agent-runtime";
import { agentPolicy, parseScenario, type ModelAnswer } from "@repo/contracts";
import { Coordinator } from "./coordinator";
import scenario from "../../../../experiments/scenarios/dev/town.json";
const live = process.env.RUN_INTEGRATION === "1" ? test : test.skip;
live(
  "three concurrent citizen decisions keep private prompts and commit each chosen physical action once",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!),
      worlds = new WorldStore(db),
      agents = new AgentStore(db),
      coordinator = new Coordinator(worlds);
    let runId = "";
    const seen = new Set<string>();
    let calls = 0;
    try {
      const input = parseScenario(scenario);
      for (const citizen of input.citizens)
        citizen.initialMemories = [
          `Only ${citizen.id} knows this private seed.`,
        ];
      runId = (
        await worlds.create(
          input,
          "concurrent-town-provider-fixture",
          undefined,
          input.citizens.map((citizen) => ({
            provider: "fixture" as const,
            citizenId: citizen.id,
            model: agentPolicy.model,
            maxRequests: 10,
            spendingLimitMicroUsd: 100000,
          })),
        )
      ).state.runId;
      await coordinator.execute(runId, {
        id: "start",
        action: { kind: "set-status", status: "running" },
      });
      await coordinator.execute(runId, {
        id: "ready",
        action: { kind: "advance", durationMs: 1000 },
      });
      const tasks = await Promise.all(
        input.citizens.map(
          async (citizen) =>
            (await agents.status(runId, citizen.id))!.control.taskId!,
        ),
      );
      const runner = new AgentRunner(worlds, agents, coordinator, () => ({
        async respond(request): Promise<ModelAnswer> {
          calls++;
          const context = JSON.parse(request.context),
            id = context.identity.id;
          seen.add(id);
          for (const other of input.citizens.filter((c) => c.id !== id))
            expect(request.context).not.toContain(`Only ${other.id} knows`);
          const call = {
            callId: `wait-${id}`,
            name: "time_wait",
            arguments: '{"durationMs":3600000}',
          };
          return {
            responseId: `fixture-${id}`,
            model: "fixture",
            call,
            output: [
              {
                type: "function_call",
                call_id: call.callId,
                name: call.name,
                arguments: call.arguments,
              },
            ],
            inputTokens: 100,
            cachedTokens: 0,
            outputTokens: 30,
          };
        },
      }));
      await Promise.all(tasks.map((id) => runner.run(id)));
      const before = await worlds.current(runId);
      expect(seen.size).toBe(3);
      expect(calls).toBe(3);
      expect(
        Object.values(before.state.jobs).filter(
          (job) => job.status === "running",
        ),
      ).toHaveLength(3);
      expect(
        (await agents.status(runId, input.citizens[0]!.id))!.budget!.requests,
      ).toBe(3);
      await Promise.all(tasks.map((id) => runner.run(id)));
      expect(calls).toBe(3);
      expect((await worlds.current(runId)).stateHash).toBe(before.stateHash);
      await coordinator.execute(runId, {
        id: "stop",
        action: { kind: "set-status", status: "paused" },
      });
      console.log(`Concurrent town fixture ${runId}`);
    } finally {
      if (runId)
        await coordinator
          .execute(runId, {
            id: "cleanup-pause",
            action: { kind: "set-status", status: "paused" },
          })
          .catch(() => undefined);
      await coordinator.stop();
      await pool.end();
    }
  },
  60000,
);
