// Controlled sleep fixture. Real process death, no provider requests.
import "../packages/db/src/env";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { createDatabase } from "../packages/db/src";
import { WorldStore } from "../packages/storage/src";
import {
  parseScenario,
  agentPolicy,
  contentHash,
} from "../packages/contracts/src";
import scenario from "../experiments/scenarios/dev/town.json";
const { db, pool } = createDatabase(process.env.DATABASE_URL!),
  worlds = new WorldStore(db),
  owner = crypto.randomUUID();
let runId = "",
  child: ReturnType<typeof Bun.spawn> | undefined;
await mkdir(".local", { recursive: true });
const held = ".local/town-held.json",
  wake = ".local/town-wake.json";
await rm(held, { force: true });
await rm(wake, { force: true });
const start = (mode: string, path: string) =>
  Bun.spawn(
    [
      process.execPath,
      "scripts/verify-town-restart-child.ts",
      runId,
      mode,
      path,
    ],
    {
      stdout: Bun.file(".local/town-restart.log"),
      stderr: Bun.file(".local/town-restart-error.log"),
    },
  );
try {
  const input = parseScenario(scenario);
  input.id = "three-sleeper-restart-fixture";
  input.startTimeMs = 22 * 3600000;
  input.rules.maxAdvanceMs = 3600000;
  for (const object of input.objects)
    if (object.regeneration)
      object.regeneration.nextAt =
        input.startTimeMs + object.regeneration.intervalMs;
  runId = (
    await worlds.create(
      input,
      "phase4-process-restart-fixture",
      undefined,
      input.citizens.map((citizen) => ({
        provider: "fixture" as const,
        citizenId: citizen.id,
        model: agentPolicy.model,
        memory: true,
        maxRequests: 10,
        spendingLimitMicroUsd: 100000,
      })),
    )
  ).state.runId;
  for (const citizen of input.citizens) {
    const bed = input.objects.find(
      (object) => object.ownerId === citizen.id && object.tags.includes("bed"),
    )!;
    const result = await worlds.execute(
      runId,
      owner,
      await worlds.claim(runId, owner),
      {
        id: `fixture-sleep-${citizen.id}`,
        action: {
          kind: "sleep",
          actorId: citizen.id,
          targetId: bed.id,
          durationMs: 9 * 3600000,
        },
      },
    );
    assert.equal(result.receipt.status, "accepted");
  }
  const sleeping = await worlds.current(runId);
  await worlds.release(runId, owner, await worlds.claim(runId, owner));
  child = start("hold", held);
  let deadline = Date.now() + 30000;
  while (!(await Bun.file(held).exists())) {
    assert.equal(child.exitCode, null, "Sleep process failed");
    assert(Date.now() < deadline);
    await Bun.sleep(100);
  }
  assert.equal((await Bun.file(held).json()).stateHash, sleeping.stateHash);
  child.kill("SIGKILL");
  await child.exited;
  child = start("wake", wake);
  assert.equal(await child.exited, 0, "Wake process failed");
  const result = await Bun.file(wake).json();
  assert.equal(result.beforeHash, sleeping.stateHash);
  assert.equal(result.beforeTime, sleeping.state.simTimeMs);
  assert.equal(result.state.simTimeMs, 31 * 3600000);
  assert.equal(
    Object.values(result.state.citizens).filter((citizen) =>
      Boolean((citizen as { actionId: string | null }).actionId),
    ).length,
    0,
  );
  assert.equal(
    Object.values(result.state.jobs).filter(
      (job) => (job as { status: string }).status === "completed",
    ).length,
    3,
  );
  assert.equal(result.consolidationTasks.length, 3);
  for (const task of result.consolidationTasks)
    assert(
      task.cutoff < result.state.sequence,
      "Sleep consolidation must retain its pre-sleep evidence cutoff",
    );
  assert.equal(
    await contentHash((await worlds.load(runId)).state),
    result.stateHash,
  );
  const report = {
    status: "passed",
    kind: "controlled fixture, not autonomous-day evidence",
    runId,
    frozenDuringDowntime: true,
    threeCitizensWoke: true,
    consolidationTasks: result.consolidationTasks,
    finalHash: result.stateHash,
    modelCalls: 0,
  };
  await Bun.write(
    ".local/phase-4-sleep-restart-proof.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
} finally {
  if (child?.exitCode === null) {
    child.kill("SIGKILL");
    await child.exited;
  }
  await pool.end();
}
