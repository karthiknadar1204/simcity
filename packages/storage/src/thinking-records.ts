import type { Database } from "@repo/db";
import { and, eq, sql } from "drizzle-orm";
import {
  agentControls,
  backgroundTasks,
  outbox,
  thinkingTurns,
} from "@repo/db/tables";
import {
  agentPolicy,
  type AgentConfiguration,
  type AgentGuard,
  type Command,
  type Transition,
  type WorldState,
} from "@repo/contracts";
import { decisionTriggers } from "./thinking-policy";
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export class ThinkingError extends Error {
  constructor(
    readonly code: "stale" | "paused" | "limited" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

export async function enqueueThinking(
  tx: Transaction,
  state: WorldState,
  citizenId: string,
  version: number,
  reasons: string[],
) {
  const taskId = crypto.randomUUID();
  await tx
    .insert(backgroundTasks)
    .values({
      id: taskId,
      runId: state.runId,
      kind: "agent.think",
      payload: { runId: state.runId, citizenId, version },
      status: "pending",
    });
  await tx
    .insert(thinkingTurns)
    .values({
      id: taskId,
      citizenId,
      version,
      reasons,
      availableAtMs: state.simTimeMs + agentPolicy.debounceMs,
    });
  await tx.insert(outbox).values({ taskId });
  return taskId;
}

export async function initializeThinking(
  tx: Transaction,
  state: WorldState,
  configuration: AgentConfiguration,
) {
  const taskId = await enqueueThinking(tx, state, configuration.citizenId, 1, [
    "self-initiated",
  ]);
  await tx
    .insert(agentControls)
    .values({
      runId: state.runId,
      citizenId: configuration.citizenId,
      configuration,
      version: 1,
      status: "active",
      taskId,
      nextReviewAtMs: state.simTimeMs,
      pendingReasons: ["self-initiated"],
    });
}

export async function assertThinkingGuard(
  tx: Transaction,
  state: WorldState,
  guard: AgentGuard,
  requireCurrent = true,
) {
  const [row] = await tx
    .select({
      ownerId: thinkingTurns.ownerId,
      generation: thinkingTurns.generation,
      valid: sql<boolean>`${thinkingTurns.leaseUntil} > clock_timestamp()`,
      citizenId: thinkingTurns.citizenId,
      version: thinkingTurns.version,
      taskId: agentControls.taskId,
      controlVersion: agentControls.version,
      controlStatus: agentControls.status,
    })
    .from(thinkingTurns)
    .innerJoin(backgroundTasks, eq(backgroundTasks.id, thinkingTurns.id))
    .innerJoin(
      agentControls,
      and(
        eq(agentControls.runId, backgroundTasks.runId),
        eq(agentControls.citizenId, thinkingTurns.citizenId),
      ),
    )
    .where(
      and(
        eq(thinkingTurns.id, guard.taskId),
        eq(backgroundTasks.runId, state.runId),
      ),
    )
    .limit(1);
  if (
    !row ||
    row.ownerId !== guard.ownerId ||
    row.generation !== guard.generation ||
    !row.valid ||
    row.citizenId !== guard.citizenId ||
    row.version !== guard.version
  )
    throw new ThinkingError("stale", "Thinking ownership changed or expired.");
  if (
    requireCurrent &&
    (row.taskId !== guard.taskId ||
      row.controlVersion !== guard.version ||
      row.controlStatus !== "active")
  )
    throw new ThinkingError("stale", "Citizen context was superseded.");
  if (requireCurrent && state.status !== "running")
    throw new ThinkingError(
      "paused",
      "World is paused; saved thinking will resume later.",
    );
}

export async function recordThinkingTriggers(
  tx: Transaction,
  before: WorldState,
  result: Transition,
  command: Command,
  guard?: AgentGuard,
) {
  const controls = await tx
    .select()
    .from(agentControls)
    .where(
      and(
        eq(agentControls.runId, before.runId),
        eq(agentControls.status, "active"),
      ),
    );
  for (const control of controls) {
    const citizen = result.state.citizens[control.citizenId]!;
    const job = citizen.actionId ? result.state.jobs[citizen.actionId] : null;
    let reasons = decisionTriggers(
      before,
      result.state,
      result.events,
      citizen.id,
    );
    if (guard?.citizenId === citizen.id && command.action.kind === "cancel")
      reasons = reasons.filter((reason) => reason !== "action-result");
    if (
      !guard &&
      "actorId" in command.action &&
      command.action.actorId === citizen.id
    )
      reasons.push("operator-action");
    if (
      !control.taskId &&
      result.state.simTimeMs >= control.nextReviewAtMs &&
      (!job || job.kind === "move")
    )
      reasons.push("review");
    if (job?.kind === "sleep" || !reasons.length) continue;
    reasons = [...new Set([...control.pendingReasons, ...reasons])].slice(-10);
    const [existing] = control.taskId
      ? await tx
          .select()
          .from(thinkingTurns)
          .where(eq(thinkingTurns.id, control.taskId))
          .limit(1)
      : [];
    if (existing && existing.boundarySequence === null) {
      await tx
        .update(thinkingTurns)
        .set({ reasons })
        .where(eq(thinkingTurns.id, existing.id));
      await tx
        .update(agentControls)
        .set({ pendingReasons: reasons })
        .where(
          and(
            eq(agentControls.runId, before.runId),
            eq(agentControls.citizenId, citizen.id),
          ),
        );
      continue;
    }
    if (existing) {
      await tx
        .update(backgroundTasks)
        .set({ status: "superseded" })
        .where(eq(backgroundTasks.id, existing.id));
      await tx
        .update(thinkingTurns)
        .set({ outcome: "superseded by new evidence" })
        .where(eq(thinkingTurns.id, existing.id));
    }
    const version = control.version + 1;
    const taskId = await enqueueThinking(
      tx,
      result.state,
      citizen.id,
      version,
      reasons,
    );
    await tx
      .update(agentControls)
      .set({ version, taskId, pendingReasons: reasons })
      .where(
        and(
          eq(agentControls.runId, before.runId),
          eq(agentControls.citizenId, citizen.id),
        ),
      );
  }
}
