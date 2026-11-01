// Separate OS processes, saved scripted response, zero OpenAI requests.
import "../packages/db/src/env";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createDatabase } from "../packages/db/src";
import {
  WorldStore,
  MemoryStore,
  MemoryWorkStore,
} from "../packages/storage/src";
import { MemoryRunner } from "../packages/agent-runtime/src";
import {
  agentPolicy,
  memoryPolicy,
  parseScenario,
  type Command,
  type MemoryExtraction,
} from "../packages/contracts/src";
import scenario from "../experiments/scenarios/dev/town.json";
const { db, pool } = createDatabase(process.env.DATABASE_URL!);
const worlds = new WorldStore(db),
  memory = new MemoryStore(db),
  work = new MemoryWorkStore(db),
  owner = crypto.randomUUID();
const mode = process.argv[2];
if (mode === "--hold") {
  const taskId = process.argv[3]!;
  const claim = await work.begin(taskId, owner, true);
  assert(claim);
  const runner = new MemoryRunner(
    memory,
    work,
    {
      async respond() {
        throw new Error("No inference in holder");
      },
    },
    true,
  );
  const request = await runner.requestFor(claim);
  assert(request);
  const data = JSON.parse(request.input),
    source = data.sources[0];
  const extraction: MemoryExtraction = {
    title: "Restart fixture",
    summary: "A personal experience was recorded before worker replacement.",
    summaryEvidence: [{ sourceId: source.id, quote: source.content }],
    agreements: [],
    claims: [],
  };
  await work.reserveCall(
    claim.payload.runId,
    claim.payload.citizenId,
    claim.guard,
    "main",
    request,
  );
  await work.saveAnswer(claim.payload.runId, claim.guard, "main", {
    model: memoryPolicy.extractionModel,
    data: extraction,
    inputTokens: 100,
    cachedTokens: 0,
    outputTokens: 50,
  });
  console.log(`READY ${taskId}`);
  setInterval(() => undefined, 1000);
  await new Promise<void>(() => undefined);
} else if (mode === "--consume") {
  const taskId = process.argv[3]!,
    runId = process.argv[4]!;
  let providerRequests = 0;
  try {
    const runner = new MemoryRunner(
      memory,
      work,
      {
        async respond() {
          providerRequests++;
          throw new Error("Saved response must be reused");
        },
      },
      true,
    );
    await runner.run(taskId);
    console.log(
      JSON.stringify({
        providerRequests,
        stateHash: (await worlds.current(runId)).stateHash,
      }),
    );
  } finally {
    await pool.end();
  }
} else {
  let runId = "";
  const execute = async (command: Command) =>
    worlds.execute(runId, owner, await worlds.claim(runId, owner), command);
  try {
    const input = parseScenario(scenario),
      self = input.citizens[0]!,
      peer = input.citizens[1]!;
    self.initialMemories = [];
    peer.position = { x: self.position.x + 1, y: self.position.y };
    runId = (
      await worlds.create(input, "memory-process-provider-fixture", undefined, {
        provider: "fixture",
        citizenId: self.id,
        model: agentPolicy.model,
        maxRequests: 4,
        spendingLimitMicroUsd: 50000,
        memory: true,
      })
    ).state.runId;
    await execute({
      id: "heard-experience",
      action: {
        kind: "say",
        actorId: peer.id,
        audienceIds: [self.id],
        text: "A breeze passed through the town.",
      },
    });
    const taskId = (await work.status(runId, self.id)).find(
      (item) => item.task.operation === "extract",
    )!.task.id;
    const holder = Bun.spawn(
      [process.execPath, import.meta.path, "--hold", taskId],
      { stdout: "pipe", stderr: "pipe" },
    );
    const reader = holder.stdout.getReader();
    const ready = await reader.read();
    assert(new TextDecoder().decode(ready.value).includes(`READY ${taskId}`));
    holder.kill("SIGKILL");
    await holder.exited;
    reader.releaseLock();
    assert.equal((await work.call(taskId, "main"))!.status, "responded");
    console.log(
      `Killed memory worker after response persistence for ${runId}; waiting for its ${memoryPolicy.leaseMs}ms lease to expire.`,
    );
    await Bun.sleep(memoryPolicy.leaseMs + 500);
    async function consume() {
      const child = Bun.spawn(
        [process.execPath, import.meta.path, "--consume", taskId, runId],
        { stdout: "pipe", stderr: "pipe" },
      );
      const stdout = await new Response(child.stdout).text();
      assert.equal(
        await child.exited,
        0,
        await new Response(child.stderr).text(),
      );
      return JSON.parse(stdout.trim()) as {
        providerRequests: number;
        stateHash: string;
      };
    }
    const resumed = await consume(),
      repeated = await consume();
    assert.equal(resumed.providerRequests, 0);
    assert.equal(repeated.providerRequests, 0);
    assert.equal(resumed.stateHash, repeated.stateHash);
    assert.equal(
      (await work.status(runId, self.id)).find(
        (item) => item.task.id === taskId,
      )!.status,
      "completed",
    );
    const current = await worlds.current(runId);
    assert(
      (await memory.list(runId, self.id, current.state.sequence)).some(
        (item) => item.title === "Restart fixture",
      ),
    );
    assert.equal((await worlds.load(runId)).stateHash, current.stateHash);
    const report = {
      kind: "memory-process-scripted-provider-fixture",
      verifiedAt: new Date().toISOString(),
      runId,
      taskId,
      processKilled: true,
      savedResponseReused: true,
      openAIRequests: 0,
      replayedTaskProviderRequests: 0,
      finalSequence: current.state.sequence,
      finalStateHash: current.stateHash,
    };
    await mkdir(".local", { recursive: true });
    await Bun.write(
      ".local/memory-restart-proof.json",
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (runId)
      await worlds.release(runId, owner, await worlds.claim(runId, owner));
    await pool.end();
  }
}
