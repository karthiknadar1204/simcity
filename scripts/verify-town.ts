// Real independently prompted OpenAI citizens. Clock acceleration is operator
// infrastructure; this script never chooses a citizen's action or writes a goal.
import "../packages/db/src/env";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createDatabase } from "../packages/db/src";
import {
  WorldStore,
  AgentStore,
  MemoryStore,
  MemoryWorkStore,
} from "../packages/storage/src";
import {
  AgentRunner,
  MemoryRunner,
  MemoryQueries,
  ContextCompiler,
  createOpenAIModel,
  createOpenAIMemoryModel,
} from "../packages/agent-runtime/src";
import {
  parseScenario,
  agentPolicy,
  activeConversation,
  type Command,
  type AgentGuard,
  type WorldState,
} from "../packages/contracts/src";
import { runProvenance } from "../apps/api/src/services/run-provenance";
import scenario from "../experiments/scenarios/dev/town-day.json";
import { retryDatabase } from "./lib/database";
if (process.env.RUN_MODEL_TESTS !== "1")
  throw new Error("Set RUN_MODEL_TESTS=1 for this capped paid town pilot.");
const { db, pool } = createDatabase(process.env.DATABASE_URL!);
const worlds = new WorldStore(db),
  agents = new AgentStore(db),
  memory = new MemoryStore(db),
  work = new MemoryWorkStore(db),
  owner = crypto.randomUUID();
const key = process.env.OPENAI_API_KEY || process.env.openai_api_key;
assert(key);
const memoryModel = createOpenAIMemoryModel(key),
  queries = new MemoryQueries(memory, work, memoryModel),
  compiler = new ContextCompiler(memory, queries),
  memRunner = new MemoryRunner(memory, work, memoryModel);
let runId = "",
  steps = 0;
const identities = new Set<string>();
const decisions: {
  citizenId: string;
  tool: string;
  inputTokens: number;
  outputTokens: number;
}[] = [];
const report: Record<string, unknown> = {
  kind: "live-openai-three-citizen-development-pilot",
  startedAt: new Date().toISOString(),
  scriptedCitizenActions: false,
  initialConditions:
    "Versioned town-day-v1: morning public-square positions, private biography/motivations and 22:00/07:00 rhythm preferences. Work durations and kitchen capabilities are scenario data.",
};
const execute = async (id: string, command: Command, guard?: AgentGuard) =>
  retryDatabase(async () =>
    worlds.execute(id, owner, await worlds.claim(id, owner), command, guard),
  );
const actor = new AgentRunner(
  worlds,
  agents,
  { execute },
  (model) => {
    const client = createOpenAIModel(key, model);
    return {
      async respond(request, signal) {
        const context = JSON.parse(request.context);
        const citizenId = context.identity.id;
        identities.add(citizenId);
        const answer = await client.respond(request, signal);
        decisions.push({
          citizenId,
          tool: answer.call?.name ?? "continue",
          inputTokens: answer.inputTokens,
          outputTokens: answer.outputTokens,
        });
        console.log(
          `${citizenId}: ${answer.call?.name ?? "continue"} @ ${context.calendar.day}/${context.calendar.hour}:${context.calendar.minute}`,
        );
        return answer;
      },
    };
  },
  compiler,
  queries,
);
async function command(action: Command["action"]) {
  return (await execute(runId, { id: crypto.randomUUID(), action })).state;
}
async function advance(state: WorldState) {
  const statuses = await Promise.all(
    Object.keys(state.citizens).map((id) =>
      retryDatabase(() => agents.status(runId, id)),
    ),
  );
  for (const status of statuses)
    assert(!status?.control.error, status?.control.error ?? "Citizen error");
  const pending = statuses.flatMap(
    (status) =>
      status?.turns
        .filter(
          (turn) =>
            turn.id === status.control.taskId &&
            ["pending", "queued", "running"].includes(turn.status),
        )
        .map((turn) => turn.availableAtMs) ?? [],
  );
  const times = [
    ...pending,
    ...statuses
      .filter((status) => !status?.control.taskId)
      .map((status) => status!.control.nextReviewAtMs),
    ...Object.values(state.jobs)
      .filter((job) => job.status === "running")
      .map((job) => (job.kind === "move" ? job.nextStepAt : job.endsAt)),
    ...Object.values(state.conversations ?? {})
      .filter((item) => item.status !== "ended")
      .map((item) => item.expiresAtMs),
  ].filter((time) => time > state.simTimeMs);
  const target = Math.min(state.simTimeMs + state.rules.maxAdvanceMs, ...times);
  return command({
    kind: "advance",
    durationMs: Math.max(1, target - state.simTimeMs),
  });
}
try {
  const input = parseScenario(scenario);
  const { revision, provenance } = await runProvenance("phase-4");
  const configurations = input.citizens.map((citizen) => ({
    provider: "openai" as const,
    citizenId: citizen.id,
    model: agentPolicy.model,
    memory: true,
    maxRequests: 2000,
    spendingLimitMicroUsd: 1500000,
  }));
  runId = (await worlds.create(input, revision, provenance, configurations))
    .state.runId;
  report.runId = runId;
  console.log(`Live town ${runId}, total cap $1.50 / 2000 model operations.`);
  await command({ kind: "set-status", status: "running" });
  const end = input.startTimeMs + input.rules.dayLengthMs + 3600000;
  while (steps++ < 1800) {
    let state = (await retryDatabase(() => worlds.current(runId))).state;
    assert.equal(
      state.status,
      "running",
      "World paused after a model limit or rejection.",
    );
    for (const task of await retryDatabase(() =>
      agents.candidates(false, runId),
    ))
      await retryDatabase(() => actor.run(task.id));
    const memoryTasks = await retryDatabase(() =>
      work.candidates(false, runId),
    );
    memoryTasks.sort(
      (a, b) =>
        (a.operation === "extract"
          ? 0
          : a.operation === "consolidate"
            ? 1
            : 2) -
        (b.operation === "extract" ? 0 : b.operation === "consolidate" ? 1 : 2),
    );
    for (const task of memoryTasks.slice(0, 8))
      await retryDatabase(() => memRunner.run(task.id));
    state = (await retryDatabase(() => worlds.current(runId))).state;
    if (state.simTimeMs >= end) break;
    if ((await retryDatabase(() => agents.candidates(false, runId))).length)
      continue;
    await advance(state);
    if (steps % 25 === 0)
      console.log(
        `Clock ${(state.simTimeMs / 3600000).toFixed(2)}h; ${decisions.length} actor calls; ${steps} transitions`,
      );
  }
  const state = (await worlds.current(runId)).state;
  const allJobs = Object.values(state.jobs),
    conversations = Object.values(state.conversations ?? {});
  const currentMemories = await Promise.all(
    input.citizens.map((citizen) =>
      memory.list(runId, citizen.id, state.sequence),
    ),
  );
  const gates = {
    threeIndependentContexts: identities.size === 3,
    dayElapsed: state.simTimeMs - input.startTimeMs >= input.rules.dayLengthMs,
    selfInitiatedActivities: input.citizens.every((citizen) =>
      allJobs.some((job) => job.actorId === citizen.id),
    ),
    citizenInitiatedConversation: conversations.some(
      (item) => item.turns.length >= 2,
    ),
    memoryInformedChoice: Object.values(state.citizens).some((citizen) =>
      citizen.plan?.evidenceIds.some((id) => !id.startsWith("seed-")),
    ),
    revisedPlan: Object.values(state.citizens).some(
      (citizen) => (citizen.plan?.version ?? 0) > 1,
    ),
    eachSleptAndWoke: input.citizens.every((citizen) =>
      allJobs.some(
        (job) =>
          job.actorId === citizen.id &&
          job.kind === "sleep" &&
          job.status === "completed" &&
          job.finishedAt !== null &&
          job.finishedAt >= input.rules.dayLengthMs,
      ),
    ),
    nextMorningAwake: input.citizens.every((citizen) => {
      const job = state.citizens[citizen.id]!.actionId
        ? state.jobs[state.citizens[citizen.id]!.actionId!]
        : null;
      return job?.kind !== "sleep";
    }),
    persistentExperiences: currentMemories.every((items) =>
      items.some((item) =>
        item.sourceIds.some((id) => !id.startsWith("seed-")),
      ),
    ),
    replayHashEqual:
      (await worlds.load(runId)).stateHash ===
      (await worlds.current(runId)).stateHash,
  };
  report.gates = gates;
  report.status = Object.values(gates).every(Boolean) ? "passed" : "failed";
  report.conversations = conversations;
  report.citizens = Object.values(state.citizens).map((citizen) => ({
    id: citizen.id,
    needs: citizen.needs,
    position: citizen.position,
    plan: citizen.plan,
    conversation: activeConversation(state, citizen.id)?.id ?? null,
    jobs: allJobs.filter((job) => job.actorId === citizen.id),
  }));
  assert(
    Object.values(gates).every(Boolean),
    "The full-day development gate was not reached; inspect the saved trace.",
  );
} catch (error) {
  report.status = "failed";
  report.error = error instanceof Error ? error.message : "Unknown pilot error";
  throw error;
} finally {
  if (runId) {
    await command({ kind: "set-status", status: "paused" }).catch(
      () => undefined,
    );
    try {
      const final = await retryDatabase(() => worlds.current(runId));
      report.finalSequence = final.state.sequence;
      report.finalTimeMs = final.state.simTimeMs;
      report.finalStateHash = final.stateHash;
      report.budget = (
        await agents.status(runId, Object.keys(final.state.citizens)[0]!)
      )?.budget;
      await retryDatabase(async () =>
        worlds.release(runId, owner, await worlds.claim(runId, owner)),
      );
    } catch (error) {
      report.cleanupError =
        error instanceof Error ? error.name : "CleanupError";
    }
  }
  report.decisions = decisions;
  report.steps = steps;
  report.finishedAt = new Date().toISOString();
  await mkdir(".local", { recursive: true });
  await Bun.write(
    `.local/town-pilot-${runId}.json`,
    JSON.stringify(report, null, 2),
  );
  await Bun.write(
    ".local/phase-4-live-proof.json",
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      runId,
      status: report.status,
      gates: report.gates,
      budget: report.budget,
      error: report.error,
    }),
  );
  await pool.end();
}
