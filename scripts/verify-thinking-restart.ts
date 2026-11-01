// Separate OS processes and a deliberately scripted provider. Zero OpenAI requests.
import "../packages/db/src/env";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { createDatabase } from "../packages/db/src";
import { WorldStore, AgentStore } from "../packages/storage/src";
import { AgentRunner } from "../packages/agent-runtime/src";
import {
  agentPolicy,
  parseScenario,
  type AgentGuard,
  type Command,
  type ModelAnswer,
} from "../packages/contracts/src";
import scenario from "../experiments/scenarios/dev/town.json";
const { db, pool } = createDatabase(process.env.DATABASE_URL!);
const worlds = new WorldStore(db),
  agents = new AgentStore(db),
  owner = crypto.randomUUID();
const mode = process.argv[2];
async function execute(id: string, command: Command, guard?: AgentGuard) {
  const generation = await worlds.claim(id, owner);
  return worlds.execute(id, owner, generation, command, guard);
}
async function release(id: string) {
  const generation = await worlds.claim(id, owner);
  await worlds.release(id, owner, generation);
}
if (mode === "--hold") {
  const runId = process.argv[3]!,
    citizenId = process.argv[4]!;
  const status = await agents.status(runId, citizenId);
  console.log(`READY ${status!.control.taskId}`);
  setInterval(() => undefined, 1000);
  await new Promise<void>(() => undefined);
} else if (mode === "--consume") {
  const runId = process.argv[3]!,
    taskId = process.argv[4]!;
  let requests = 0;
  try {
    const runner = new AgentRunner(worlds, agents, { execute }, () => ({
      async respond(): Promise<ModelAnswer> {
        requests++;
        const callId = "fixture-call",
          args = JSON.stringify({ durationMs: 60000 });
        return {
          model: "fixture",
          responseId: "fixture-response",
          output: [
            {
              type: "function_call",
              call_id: callId,
              name: "time_wait",
              arguments: args,
            },
          ],
          call: { callId, name: "time_wait", arguments: args },
          inputTokens: 100,
          cachedTokens: 0,
          outputTokens: 30,
        };
      },
    }));
    await runner.run(taskId);
    console.log(
      JSON.stringify({
        fixtureProviderRequests: requests,
        stateHash: (await worlds.current(runId)).stateHash,
      }),
    );
  } finally {
    await release(runId);
    await pool.end();
  }
} else {
  let runId = "";
  async function stopFixture() {
    if (runId) {
      await execute(runId, {
        id: "thinking-restart-stop",
        action: { kind: "set-status", status: "paused" },
      });
      await release(runId);
    }
  }
  try {
    const input = parseScenario(scenario),
      citizenId = input.citizens[0]!.id;
    const created = await worlds.create(
      input,
      "thinking-process-fixture",
      undefined,
      {
        provider: "fixture",
        citizenId,
        model: agentPolicy.model,
        spendingLimitMicroUsd: 50000,
        maxRequests: 3,
      },
    );
    runId = created.state.runId;
    const before = (await agents.status(runId, citizenId))!,
      taskId = before.control.taskId!;
    const hold = Bun.spawn(
      [process.execPath, import.meta.path, "--hold", runId, citizenId],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = hold.stdout.getReader();
    const first = await reader.read();
    assert(new TextDecoder().decode(first.value).includes(`READY ${taskId}`));
    hold.kill("SIGKILL");
    await hold.exited;
    reader.releaseLock();
    assert.equal(
      (await agents.status(runId, citizenId))!.control.taskId,
      taskId,
    );
    await execute(runId, {
      id: "thinking-restart-start",
      action: { kind: "set-status", status: "running" },
    });
    await execute(runId, {
      id: "thinking-restart-ready",
      action: { kind: "advance", durationMs: 1000 },
    });
    await release(runId);
    async function consume() {
      const child = Bun.spawn(
        [process.execPath, import.meta.path, "--consume", runId, taskId],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(child.stdout).text();
      assert.equal(
        await child.exited,
        0,
        await new Response(child.stderr).text(),
      );
      return JSON.parse(stdout.trim()) as {
        fixtureProviderRequests: number;
        stateHash: string;
      };
    }
    const resumed = await consume(),
      repeated = await consume();
    assert.equal(resumed.fixtureProviderRequests, 1);
    assert.equal(repeated.fixtureProviderRequests, 0);
    assert.equal(resumed.stateHash, repeated.stateHash);
    const state = (await worlds.current(runId)).state,
      job = state.jobs[state.citizens[citizenId]!.actionId!]!;
    assert.equal(job.kind, "wait");
    await stopFixture();
    const final = await worlds.current(runId);
    const report = {
      kind: "thinking-process-provider-fixture",
      runId,
      taskId,
      verifiedAt: new Date().toISOString(),
      processKilled: true,
      pendingTaskPreserved: true,
      fixtureProviderRequests: 1,
      openAIRequests: 0,
      replayedTaskProviderRequests: 0,
      stateHashAfterConsumption: resumed.stateHash,
      finalSequence: final.state.sequence,
      finalStateHash: final.stateHash,
    };
    await mkdir(".local", { recursive: true });
    await Bun.write(
      ".local/thinking-restart-proof.json",
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await stopFixture().catch(() => undefined);
    await pool.end();
  }
}
