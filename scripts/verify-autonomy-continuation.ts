// Follow-up to a timed-out development pilot; never reported as the original pilot passing.
import "../packages/db/src/env";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import type { WorldState, RunManifest } from "../packages/contracts/src";

const runId = process.argv[2];
assert(runId, "Supply the paused AI development run ID to resume.");
const base = `http://127.0.0.1:3001/api/world/runs/${encodeURIComponent(runId)}`;
const headers = {
  "Content-Type": "application/json",
  ...(process.env.OPERATOR_TOKEN
    ? { Authorization: `Bearer ${process.env.OPERATOR_TOKEN}` }
    : {}),
};
async function request<T>(path = "", body?: unknown): Promise<T> {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  assert(response.ok, `HTTP ${response.status} during live continuation.`);
  return (await response.json()) as T;
}
async function status(value: "running" | "paused") {
  return request<{ state: WorldState }>("/commands", {
    id: crypto.randomUUID(),
    action: { kind: "set-status", status: value },
  });
}
const initial = await request<{ state: WorldState; manifest: RunManifest }>();
assert.equal(initial.manifest.agent?.provider, "openai");
assert.equal(
  initial.state.status,
  "paused",
  "Only resume an explicitly selected paused run.",
);
const citizenId = initial.manifest.agent!.citizenId;
type Trace = {
  control: { taskId: string | null; error: string | null };
  budget: { requests: number; spentMicroUsd: number; reservedMicroUsd: number };
  turns: { id: string; rounds: unknown[] }[];
};
const trace = async () =>
  (await request<{ thinking: Trace }>(`/citizens/${citizenId}/thinking`))
    .thinking;
const before = await trace();
assert(
  !before.control.error,
  before.control.error || "Resolve the saved run's error first.",
);
try {
  await status("running");
  const deadline = Date.now() + 120000;
  let completed: WorldState["jobs"][string] | undefined;
  while (Date.now() < deadline) {
    const { state } = await request<{ state: WorldState }>();
    completed = Object.values(state.jobs).find(
      (job) =>
        job.actorId === citizenId &&
        job.kind === "move" &&
        job.status === "completed" &&
        job.startedAt >= initial.state.simTimeMs,
    );
    if (completed) break;
    const current = await trace();
    assert(
      !current.control.error,
      current.control.error || "Citizen thinking error.",
    );
    await Bun.sleep(500);
  }
  assert(
    completed,
    "The resumed citizen did not complete another walk in the bounded continuation.",
  );
  const final = (await status("paused")).state;
  const [current, replay, after] = await Promise.all([
    request<{ stateHash: string }>(),
    request<{ stateHash: string }>(`/replay?sequence=${final.sequence}`),
    trace(),
  ]);
  assert.equal(current.stateHash, replay.stateHash);
  const report = {
    kind: "live-openai-resumed-development-pilot",
    runId,
    citizenId,
    verifiedAt: new Date().toISOString(),
    countsAsOriginalPilotPass: false,
    humanAssignedGoal: false,
    destinationInjected: false,
    resumedTaskId: before.control.taskId,
    savedRoundsBeforeResume:
      before.turns.find((turn) => turn.id === before.control.taskId)?.rounds
        .length ?? 0,
    initialSequence: initial.state.sequence,
    initialPlan: initial.state.citizens[citizenId]!.plan,
    completedMovement: completed,
    finalPlan: final.citizens[citizenId]!.plan,
    finalSequence: final.sequence,
    finalStateHash: current.stateHash,
    additionalModelRequests: after.budget.requests - before.budget.requests,
    totalModelRequests: after.budget.requests,
    estimatedInferenceMicroUsd: after.budget.spentMicroUsd,
    reservedMicroUsd: after.budget.reservedMicroUsd,
    checks: [
      "saved citizen state resumed",
      "model-chosen movement completed",
      "replay hash equality",
    ],
  };
  await mkdir(".local", { recursive: true });
  await Bun.write(
    ".local/phase-2-resumed-live-proof.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await status("paused").catch(() => undefined);
}
