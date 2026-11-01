// Scripted provider fixtures exercise runtime correctness; they are not autonomous evidence.
import { test, expect } from "bun:test";
import "@repo/db/env";
import { createDatabase } from "@repo/db";
import { AgentStore, WorldStore } from "@repo/storage";
import {
  agentPolicy,
  parseScenario,
  type ModelAnswer,
  type Command,
  type AgentGuard,
} from "@repo/contracts";
import scenario from "../../../experiments/scenarios/dev/town.json";
import { AgentRunner } from "./runner";
import { buildContext } from "./context";
import { ModelRequestRejected } from "./openai";
const live = process.env.RUN_INTEGRATION === "1" ? test : test.skip;
function answer(name: string, args: unknown): ModelAnswer {
  const callId = crypto.randomUUID(),
    parameters = JSON.stringify(args);
  return {
    responseId: `fixture-${crypto.randomUUID()}`,
    model: "fixture",
    output: [
      { type: "function_call", call_id: callId, name, arguments: parameters },
    ],
    call: { callId, name, arguments: parameters },
    inputTokens: 100,
    cachedTokens: 0,
    outputTokens: 50,
  };
}
live(
  "runtime uses real rejected receipts, retries a valid action, and resumes a saved response without another model request",
  async () => {
    const { db, pool } = createDatabase(process.env.DATABASE_URL!);
    const worlds = new WorldStore(db),
      agents = new AgentStore(db),
      owner = crypto.randomUUID();
    let runId: string | null = null;
    const port = {
      async execute(id: string, command: Command, guard?: AgentGuard) {
        const generation = await worlds.claim(id, owner);
        return worlds.execute(id, owner, generation, command, guard);
      },
    };
    try {
      const input = parseScenario(scenario),
        citizen = input.citizens[0]!;
      const created = await worlds.create(
        input,
        "runtime-provider-fixture",
        undefined,
        {
          provider: "fixture",
          citizenId: citizen.id,
          model: agentPolicy.model,
          spendingLimitMicroUsd: 100000,
          maxRequests: 8,
        },
      );
      runId = created.state.runId;
      await port.execute(runId, {
        id: "run-start",
        action: { kind: "set-status", status: "running" },
      });
      await port.execute(runId, {
        id: "ready",
        action: { kind: "advance", durationMs: 1000 },
      });
      let calls = 0;
      const initial = (await agents.status(runId, citizen.id))!;
      const runner = new AgentRunner(worlds, agents, port, () => ({
        async respond() {
          calls++;
          return calls === 1
            ? answer("world_interact", {
                targetId: input.objects[0]!.id,
                capabilityId: "nonexistent-capability",
                units: 1,
              })
            : answer("time_wait", { durationMs: 1000 });
        },
      }));
      await runner.run(initial.control.taskId!);
      expect(calls).toBe(2);
      const recorded = await agents.rounds(initial.control.taskId!);
      expect(recorded[0]!.outcome?.status).toBe("rejected");
      expect(recorded[1]!.outcome?.status).toBe("accepted");
      const current = await worlds.current(runId);
      expect(current.state.citizens[citizen.id]!.inventory).toEqual(
        citizen.inventory,
      );
      await port.execute(runId, {
        id: "finish-wait",
        action: { kind: "advance", durationMs: 1000 },
      });
      await port.execute(runId, {
        id: "next-ready",
        action: { kind: "advance", durationMs: 1000 },
      });
      const next = (await agents.status(runId, citizen.id))!;
      const claimed = (await agents.begin(
        next.control.taskId!,
        "before-restart",
      ))!;
      const context = buildContext(
        claimed.state,
        citizen.id,
        [],
        claimed.turn.reasons,
      );
      await agents.saveContext(
        runId,
        claimed.guard,
        context,
        claimed.state.sequence,
      );
      const request = {
        instructions: "fixture",
        context: JSON.stringify(context),
        history: [],
        inputTokens: 300,
      };
      await agents.reserveRound(runId, claimed.guard, 0, request);
      await agents.saveAnswer(
        runId,
        claimed.guard,
        0,
        answer("time_wait", { durationMs: 60000 }),
      );
      await agents.park(claimed.guard);
      const recovered = new AgentRunner(
        new WorldStore(db),
        new AgentStore(db),
        port,
        () => ({
          async respond() {
            throw new Error("Recovery must use the saved response");
          },
        }),
      );
      await recovered.run(next.control.taskId!);
      const once = await worlds.current(runId);
      const jobId = once.state.citizens[citizen.id]!.actionId!;
      expect(once.state.jobs[jobId]!.kind).toBe("wait");
      await recovered.run(next.control.taskId!);
      expect((await worlds.current(runId)).state.sequence).toBe(
        once.state.sequence,
      );
      expect(
        (await agents.rounds(next.control.taskId!))[0]!.outcome?.status,
      ).toBe("accepted");
      await port.execute(runId, {
        id: "credit-case-cancel",
        action: { kind: "cancel", actorId: citizen.id },
      });
      await port.execute(runId, {
        id: "credit-case-ready",
        action: { kind: "advance", durationMs: 1000 },
      });
      const creditCase = (await agents.status(runId, citizen.id))!;
      const creditFailure = new AgentRunner(worlds, agents, port, () => ({
        async respond() {
          throw new ModelRequestRejected("429 quota fixture");
        },
      }));
      await creditFailure.run(creditCase.control.taskId!);
      const rejected = (await agents.status(runId, citizen.id))!;
      expect(rejected.budget!.spentMicroUsd).toBe(
        creditCase.budget!.spentMicroUsd,
      );
      expect(rejected.budget!.reservedMicroUsd).toBe(0);
      expect((await agents.rounds(creditCase.control.taskId!))[0]!.status).toBe(
        "rejected",
      );
      expect((await worlds.current(runId)).state.status).toBe("paused");
      console.log(`Runtime provider fixture ${runId}`);
    } finally {
      if (runId) {
        await port
          .execute(runId, {
            id: "fixture-stop",
            action: { kind: "set-status", status: "paused" },
          })
          .catch(() => undefined);
        const generation = await worlds.claim(runId, owner);
        await worlds.release(runId, owner, generation);
      }
      await pool.end();
    }
  },
  60000,
);
