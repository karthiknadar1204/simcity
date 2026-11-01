// Live exploratory gate. Operator perturbations affect terrain/a neighbor, never the AI's choices.
import "../packages/db/src/env";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import type {
  Action,
  Receipt,
  WorldEvent,
  WorldState,
  RunManifest,
} from "../packages/contracts/src";
if (process.env.RUN_MODEL_TESTS !== "1")
  throw new Error(
    "Use RUN_MODEL_TESTS=1 to authorize this bounded live-model check.",
  );
const base = "http://127.0.0.1:3001/api/world";
const headers = {
  "Content-Type": "application/json",
  ...(process.env.OPERATOR_TOKEN
    ? { Authorization: `Bearer ${process.env.OPERATOR_TOKEN}` }
    : {}),
};
type Thinking = {
  control: { error: string | null; status: string };
  budget: { requests: number; spentMicroUsd: number };
  turns: {
    reasons: string[];
    rounds: { answer: { call: { name: string } | null } | null }[];
  }[];
};
let runId = "";
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const result = (await response.json()) as { error?: string };
  assert(response.ok, result.error || `HTTP ${response.status}`);
  return result as T;
}
async function command(action: Action) {
  const result = await request<{ state: WorldState; receipt: Receipt }>(
    `/runs/${runId}/commands`,
    { id: crypto.randomUUID(), action },
  );
  assert.equal(result.receipt.status, "accepted", result.receipt.reason);
  return result.state;
}
async function thinking(citizenId: string) {
  return (
    await request<{ thinking: Thinking }>(
      `/runs/${runId}/citizens/${citizenId}/thinking`,
    )
  ).thinking;
}
async function until<T>(
  read: () => Promise<T | null>,
  citizenId: string,
  timeoutMs: number,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const trace = await thinking(citizenId);
    assert(!trace.control.error, trace.control.error || "Citizen error");
    const result = await read();
    if (result) return result;
    await Bun.sleep(500);
  }
  throw new Error(
    "The autonomous behavior gate was not reached in the bounded pilot interval.",
  );
}
try {
  const { scenarios } = await request<{
    scenarios: { id: string; residents: { id: string }[] }[];
  }>("/scenarios");
  const scenario = scenarios[0]!,
    citizenId = scenario.residents[0]!.id;
  const created = await request<{ state: WorldState; manifest: RunManifest }>(
    "/runs",
    { scenarioId: scenario.id, autonomous: true, citizenId },
  );
  runId = created.state.runId;
  console.log(
    `Live autonomous development run ${runId}; no human goal assigned.`,
  );
  await command({ kind: "set-status", status: "running" });
  const walking = await until(
    async () => {
      const { state } = await request<{ state: WorldState }>(`/runs/${runId}`);
      const citizen = state.citizens[citizenId]!;
      const job = citizen.actionId ? state.jobs[citizen.actionId] : null;
      return job?.kind === "move" && job.status === "running" && citizen.plan
        ? { state, job, plan: citizen.plan }
        : null;
    },
    citizenId,
    90000,
  );
  let paused = await command({ kind: "set-status", status: "paused" });
  const active = paused.citizens[citizenId]!.actionId
    ? paused.jobs[paused.citizens[citizenId]!.actionId!]
    : null;
  assert(
    active?.kind === "move",
    "Walk finished before the perturbation; rerun this exploratory pilot.",
  );
  const blocked = active.path[active.stepIndex + 1]!;
  paused = await command({
    kind: "set-blocked",
    position: blocked,
    blocked: true,
  });
  paused = await command({
    kind: "advance",
    durationMs: paused.citizens[citizenId]!.moveDurationMs,
  });
  assert.equal(paused.jobs[active.id]!.status, "interrupted");
  const neighbor = Object.values(paused.citizens).find(
    (citizen) => citizen.id !== citizenId,
  )!;
  const actorPosition = paused.citizens[citizenId]!.position;
  const near = [
    { x: actorPosition.x - 1, y: actorPosition.y },
    { x: actorPosition.x + 1, y: actorPosition.y },
    { x: actorPosition.x, y: actorPosition.y - 1 },
    { x: actorPosition.x, y: actorPosition.y + 1 },
  ].find(
    (point) =>
      point.x >= 0 &&
      point.y >= 0 &&
      point.x < paused.map.width &&
      point.y < paused.map.height &&
      !paused.map.blocked.some(
        (tile) => tile.x === point.x && tile.y === point.y,
      ) &&
      !Object.values(paused.citizens).some(
        (citizen) =>
          citizen.position.x === point.x && citizen.position.y === point.y,
      ),
  );
  assert(near, "No adjacent neighbor fixture location.");
  await command({ kind: "move", actorId: neighbor.id, destination: near });
  paused = await command({ kind: "advance", durationMs: 60000 });
  assert.equal(paused.citizens[neighbor.id]!.actionId, null);
  paused = await command({
    kind: "say",
    actorId: neighbor.id,
    audienceIds: [citizenId],
    text: "I am nearby. The route ahead has become blocked; how would you like to proceed?",
  });
  const perturbationBoundary = paused.sequence;
  await command({ kind: "set-status", status: "running" });
  const after = await until(
    async () => {
      const { state } = await request<{ state: WorldState }>(`/runs/${runId}`);
      const completed = Object.values(state.jobs).find(
        (job) =>
          job.actorId === citizenId &&
          job.kind === "move" &&
          job.status === "completed" &&
          job.startedAt >= paused.simTimeMs,
      );
      return completed ? { state, completed } : null;
    },
    citizenId,
    120000,
  );
  const final = await command({ kind: "set-status", status: "paused" });
  const replay = await request<{ stateHash: string }>(
    `/runs/${runId}/replay?sequence=${final.sequence}`,
  );
  const current = await request<{ stateHash: string }>(`/runs/${runId}`);
  assert.equal(replay.stateHash, current.stateHash);
  const trace = await thinking(citizenId);
  const { events } = await request<{ events: WorldEvent[] }>(
    `/runs/${runId}/events?after=0&limit=500`,
  );
  const report = {
    kind: "live-openai-development-pilot",
    runId,
    verifiedAt: new Date().toISOString(),
    model: created.manifest.agent!.model,
    humanAssignedGoal: false,
    initialPlan: walking.plan,
    operatorPerturbations: {
      blockedTile: blocked,
      neighborId: neighbor.id,
      message: true,
      eventBoundary: perturbationBoundary,
    },
    actualCompletedMovement: after.completed,
    finalPlan: final.citizens[citizenId]!.plan,
    finalSequence: final.sequence,
    finalStateHash: current.stateHash,
    inferenceRequests: trace.budget.requests,
    estimatedInferenceMicroUsd: trace.budget.spentMicroUsd,
    eventsRead: events.length,
    checks: [
      "self-initiated plan",
      "chosen destination",
      "real tile movement",
      "blocked route interruption",
      "nearby encounter/message",
      "subsequent model-chosen movement completed",
      "replay hash equality",
    ],
    limitations: [
      "exploratory development pilot, not a held-out research result",
      "other citizen and terrain perturbations were operator fixtures",
      "memory quality and long-day social evaluations are later phases",
    ],
  };
  await mkdir(".local", { recursive: true });
  await Bun.write(
    ".local/phase-2-live-proof.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (runId)
    await command({ kind: "set-status", status: "paused" }).catch(
      () => undefined,
    );
}
