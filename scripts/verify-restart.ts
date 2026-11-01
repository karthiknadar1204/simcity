// An operator fixture, never imported by the engine or citizen runtime.
import "../packages/db/src/env";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import {
  contentHash,
  type Action,
  type WorldState,
  type Receipt,
} from "../packages/contracts/src";
import { createDatabase } from "../packages/db/src";
import { WorldStore } from "../packages/storage/src";

const port = 3107;
const base = `http://127.0.0.1:${port}/api/world`;
const headers = {
  "Content-Type": "application/json",
  ...(process.env.OPERATOR_TOKEN
    ? { Authorization: `Bearer ${process.env.OPERATOR_TOKEN}` }
    : {}),
};
let child: ReturnType<typeof Bun.spawn> | undefined;
let runId = "";
let state: WorldState;
const { db, pool } = createDatabase(process.env.DATABASE_URL!);
const store = new WorldStore(db);
await mkdir(".local", { recursive: true });
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  }).catch((error: Error) => {
    throw new Error(
      `Restart verification request failed at ${path}: ${error.name}`,
    );
  });
  assert(response.ok, `HTTP ${response.status} at ${path}`);
  return (await response.json()) as T;
}
async function start() {
  child = Bun.spawn([process.execPath, "apps/api/dist/index.js"], {
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdout: Bun.file(".local/restart-api.log"),
    stderr: Bun.file(".local/restart-api-error.log"),
  });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    assert(
      child.exitCode === null,
      "Fixture API exited before readiness; inspect .local logs.",
    );
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch {
      /* Starting. */
    }
    await Bun.sleep(50);
  }
  throw new Error("Fixture API did not become ready.");
}
async function stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
  if (!child || child.exitCode !== null) return;
  child.kill(signal);
  await Promise.race([
    child.exited,
    Bun.sleep(10000).then(() => {
      throw new Error("Fixture API did not stop.");
    }),
  ]);
}
async function command(action: Action, id = crypto.randomUUID()) {
  console.log(`Fixture command: ${action.kind}`);
  const result = await request<{ state: WorldState; receipt: Receipt }>(
    `/runs/${runId}/commands`,
    { id, action },
  );
  assert.equal(result.receipt.status, "accepted", result.receipt.reason);
  state = result.state;
  return result;
}
try {
  const occupied = await fetch(`http://127.0.0.1:${port}/api/health`)
    .then(() => true)
    .catch(() => false);
  assert(
    !occupied,
    `Port ${port} is occupied; no existing server was changed.`,
  );
  await start();
  const catalog = await request<{ scenarios: { id: string }[] }>("/scenarios");
  const created = await request<{ state: WorldState }>("/runs", {
    scenarioId: catalog.scenarios[0]!.id,
  });
  state = created.state;
  runId = state.runId;
  const actors = Object.values(state.citizens);
  const actor = actors.find((entry) => entry.position.x + 3 < state.map.width)!;
  const recipient = actors.find((entry) => entry.id !== actor.id)!;
  await command({
    kind: "move",
    actorId: actor.id,
    destination: { x: actor.position.x + 3, y: actor.position.y },
  });
  await command({ kind: "advance", durationMs: actor.moveDurationMs });
  const movement = state.jobs[state.citizens[actor.id]!.actionId!]!;
  assert(movement.kind === "move");
  assert.equal(movement.stepIndex, 1);
  await command({
    kind: "set-blocked",
    position: movement.path[2]!,
    blocked: true,
  });
  await command({ kind: "advance", durationMs: actor.moveDurationMs });
  assert.equal(state.jobs[movement.id]!.status, "interrupted");
  await command({
    kind: "set-blocked",
    position: movement.path[2]!,
    blocked: false,
  });
  const adjacent = {
    x: state.citizens[recipient.id]!.position.x - 1,
    y: state.citizens[recipient.id]!.position.y,
  };
  await command({ kind: "move", actorId: actor.id, destination: adjacent });
  await command({ kind: "advance", durationMs: 60000 });
  const transfer = {
    kind: "transfer" as const,
    actorId: actor.id,
    targetId: recipient.id,
    resource: "food",
    amount: 1,
  };
  const before = state.citizens[recipient.id]!.inventory.food!;
  const transferId = crypto.randomUUID();
  await command(transfer, transferId);
  const once = state.sequence;
  await command(transfer, transferId);
  assert.equal(state.sequence, once);
  assert.equal(state.citizens[recipient.id]!.inventory.food, before + 1);
  const bed = Object.values(state.objects).find(
    (object) => object.tags.includes("bed") && object.ownerId === actor.id,
  )!;
  await command({ kind: "move", actorId: actor.id, destination: bed.position });
  await command({ kind: "advance", durationMs: 60000 });
  await command({
    kind: "sleep",
    actorId: actor.id,
    targetId: bed.id,
    durationMs: 120000,
  });
  await command({ kind: "advance", durationMs: 30000 });
  const sleeping = state.citizens[actor.id]!.actionId!;
  assert.equal(state.jobs[sleeping]!.status, "running");
  const sleepHash = await contentHash(state);
  await stop();
  await Bun.sleep(1100);
  await start();
  const restored = await request<{ state: WorldState }>(`/runs/${runId}`);
  assert.equal(await contentHash(restored.state), sleepHash);
  assert.deepEqual(restored.state.jobs[sleeping], state.jobs[sleeping]);
  await command({ kind: "advance", durationMs: 90000 });
  assert.equal(state.jobs[sleeping]!.status, "completed");
  const historical = await request<{ stateHash: string }>(
    `/runs/${runId}/replay?sequence=${state.sequence}`,
  );
  assert.equal(historical.stateHash, await contentHash(state));
  // Kill without a stop checkpoint: the current SQL state must rebuild from prior checkpoint + events.
  const crashHash = await contentHash(state);
  await stop("SIGKILL");
  assert.equal(await contentHash((await store.load(runId)).state), crashHash);
  // A dead process retains its fencing lease until expiry. Never steal a live lease.
  await Bun.sleep(15500);
  await start();
  assert.equal(
    (await request<{ stateHash: string }>(`/runs/${runId}`)).stateHash,
    crashHash,
  );
  // A running world resumes scheduled ticks, without adding the offline wall-time interval.
  await command({ kind: "set-status", status: "running" });
  await Bun.sleep(800);
  await stop();
  const stopped = await store.current(runId);
  await Bun.sleep(1600);
  const restartStartedAt = Date.now();
  await start();
  const resumed = await request<{ state: WorldState }>(`/runs/${runId}`);
  assert(
    resumed.state.simTimeMs - stopped.state.simTimeMs <=
      Date.now() - restartStartedAt + 500,
    "Offline wall time was applied.",
  );
  const progressDeadline = Date.now() + 10000;
  let progressed = resumed;
  while (
    Date.now() < progressDeadline &&
    progressed.state.simTimeMs === resumed.state.simTimeMs
  ) {
    await Bun.sleep(100);
    progressed = await request<{ state: WorldState }>(`/runs/${runId}`);
  }
  assert(
    progressed.state.simTimeMs > resumed.state.simTimeMs,
    "Running world did not resume.",
  );
  await command({ kind: "set-status", status: "paused" });
  const finalReplay = await request<{ stateHash: string }>(
    `/runs/${runId}/replay?sequence=${state.sequence}`,
  );
  assert.equal(finalReplay.stateHash, await contentHash(state));
  const report = {
    kind: "operator-physics-fixture",
    runId,
    verifiedAt: new Date().toISOString(),
    finalSequence: state.sequence,
    finalStateHash: finalReplay.stateHash,
    checks: [
      "tile steps",
      "route interruption",
      "transfer retry",
      "sleep restart",
      "crash recovery",
      "running resume",
      "offline freeze",
      "replay hash equality",
    ],
    modelCalls: 0,
  };
  await Bun.write(".local/restart-proof.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  try {
    await stop();
  } finally {
    if (runId) {
      const owner = crypto.randomUUID();
      try {
        const generation = await store.claim(runId, owner);
        await store.execute(runId, owner, generation, {
          id: "restart-fixture-cleanup",
          action: { kind: "set-status", status: "paused" },
        });
        await store.release(runId, owner, generation);
      } catch {
        console.error(
          `Restart fixture ${runId} needs cleanup after its ownership lease expires.`,
        );
      }
    }
    await pool.end();
  }
}
