import type { Database } from "@repo/db";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  agentBudgets,
  agentControls,
  backgroundTasks,
  modelRounds,
  observations,
  outbox,
  runs,
  thinkingTurns,
} from "@repo/db/tables";
import {
  agentPolicy,
  contentHash,
  stableStringify,
  type AgentGuard,
  type ModelAnswer,
  type ThinkingPayload,
  type ToolOutcome,
} from "@repo/contracts";
import {
  assertThinkingGuard,
  enqueueThinking,
  ThinkingError,
  type Transaction,
} from "./thinking-records";
import { reviewDeadline } from "./thinking-policy";

type RoundRequest = typeof modelRounds.$inferInsert.request;
export class AgentStore {
  constructor(readonly db: Database) {}
  private async lockRun(tx: Transaction, runId: string) {
    const [row] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");
    if (!row) throw new ThinkingError("unavailable", "Run not found.");
    return row;
  }
  private async task(taskId: string) {
    const [task] = await this.db
      .select()
      .from(backgroundTasks)
      .where(eq(backgroundTasks.id, taskId))
      .limit(1);
    if (!task || task.kind !== "agent.think" || !("citizenId" in task.payload))
      throw new ThinkingError("unavailable", "Thinking task not found.");
    return { ...task, payload: task.payload as ThinkingPayload };
  }
  async begin(taskId: string, ownerId: string) {
    const task = await this.task(taskId);
    return this.db.transaction(async (tx) => {
      const run = await this.lockRun(tx, task.runId);
      const [currentTask] = await tx
        .select()
        .from(backgroundTasks)
        .where(eq(backgroundTasks.id, taskId));
      const [control] = await tx
        .select()
        .from(agentControls)
        .where(
          and(
            eq(agentControls.runId, task.runId),
            eq(agentControls.citizenId, task.payload.citizenId),
          ),
        );
      const [turn] = await tx
        .select({
          data: thinkingTurns,
          liveLease: sql<boolean>`${thinkingTurns.leaseUntil} > clock_timestamp()`,
        })
        .from(thinkingTurns)
        .where(eq(thinkingTurns.id, taskId));
      if (
        !control ||
        !turn ||
        !currentTask ||
        !["pending", "queued", "running"].includes(currentTask.status) ||
        control.status !== "active" ||
        control.taskId !== taskId ||
        control.version !== task.payload.version ||
        run.state.status !== "running" ||
        turn.data.availableAtMs > run.simTimeMs
      )
        return null;
      if (turn.data.ownerId && turn.data.ownerId !== ownerId && turn.liveLease)
        return null;
      const [busy] = await tx
        .select({ id: thinkingTurns.id })
        .from(thinkingTurns)
        .innerJoin(backgroundTasks, eq(backgroundTasks.id, thinkingTurns.id))
        .where(
          and(
            eq(backgroundTasks.runId, task.runId),
            eq(thinkingTurns.citizenId, control.citizenId),
            ne(thinkingTurns.id, taskId),
            sql`${thinkingTurns.ownerId} is not null and ${thinkingTurns.leaseUntil} > clock_timestamp()`,
          ),
        )
        .limit(1);
      if (busy) return null;
      if ((await contentHash(run.state)) !== run.stateHash)
        throw new ThinkingError("unavailable", "World hash mismatch.");
      const generation = turn.data.generation + 1;
      await tx
        .update(thinkingTurns)
        .set({
          ownerId,
          generation,
          boundarySequence: turn.data.boundarySequence ?? run.sequence,
          leaseUntil: sql`clock_timestamp() + ${agentPolicy.leaseMs} * interval '1 millisecond'`,
        })
        .where(eq(thinkingTurns.id, taskId));
      await tx
        .update(backgroundTasks)
        .set({
          status: "running",
          attempts: sql`${backgroundTasks.attempts} + 1`,
        })
        .where(eq(backgroundTasks.id, taskId));
      return {
        guard: {
          taskId,
          ownerId,
          generation,
          citizenId: control.citizenId,
          version: control.version,
        } satisfies AgentGuard,
        state: run.state,
        configuration: control.configuration,
        turn: turn.data,
      };
    });
  }
  async heartbeat(guard: AgentGuard) {
    const updated = await this.db
      .update(thinkingTurns)
      .set({
        leaseUntil: sql`clock_timestamp() + ${agentPolicy.leaseMs} * interval '1 millisecond'`,
      })
      .where(
        and(
          eq(thinkingTurns.id, guard.taskId),
          eq(thinkingTurns.ownerId, guard.ownerId),
          eq(thinkingTurns.generation, guard.generation),
          sql`${thinkingTurns.leaseUntil} > clock_timestamp()`,
        ),
      )
      .returning({ id: thinkingTurns.id });
    return updated.length === 1;
  }
  async releaseLease(guard: AgentGuard) {
    await this.db
      .update(thinkingTurns)
      .set({ ownerId: null, leaseUntil: null })
      .where(
        and(
          eq(thinkingTurns.id, guard.taskId),
          eq(thinkingTurns.ownerId, guard.ownerId),
          eq(thinkingTurns.generation, guard.generation),
        ),
      );
  }
  async saveContext(
    runId: string,
    guard: AgentGuard,
    context: Record<string, unknown>,
    sequence: number,
  ) {
    await this.db.transaction(async (tx) => {
      const run = await this.lockRun(tx, runId);
      await assertThinkingGuard(tx, run.state, guard);
      const [turn] = await tx
        .select({ boundary: thinkingTurns.boundarySequence })
        .from(thinkingTurns)
        .where(eq(thinkingTurns.id, guard.taskId));
      if (!turn || turn.boundary !== sequence || sequence > run.sequence)
        throw new ThinkingError("stale", "Thinking context boundary changed.");
      await tx
        .update(thinkingTurns)
        .set({ context, boundarySequence: sequence })
        .where(
          and(
            eq(thinkingTurns.id, guard.taskId),
            isNull(thinkingTurns.context),
          ),
        );
    });
  }
  async rounds(taskId: string) {
    return this.db
      .select()
      .from(modelRounds)
      .where(eq(modelRounds.taskId, taskId))
      .orderBy(asc(modelRounds.round));
  }
  async reserveRound(
    runId: string,
    guard: AgentGuard,
    round: number,
    request: RoundRequest,
  ) {
    return this.db.transaction(async (tx) => {
      const run = await this.lockRun(tx, runId);
      await assertThinkingGuard(tx, run.state, guard);
      const [prior] = await tx
        .select()
        .from(modelRounds)
        .where(
          and(
            eq(modelRounds.taskId, guard.taskId),
            eq(modelRounds.round, round),
          ),
        );
      if (prior) {
        if (stableStringify(prior.request) !== stableStringify(request))
          throw new ThinkingError("stale", "Round input changed.");
        return prior;
      }
      if (
        round >= agentPolicy.maxRounds ||
        request.inputTokens > agentPolicy.contextTokens
      )
        throw new ThinkingError("limited", "Thinking/context limit reached.");
      const [budget] = await tx
        .select()
        .from(agentBudgets)
        .where(eq(agentBudgets.runId, runId))
        .for("update");
      const reserved = Math.ceil(
        (agentPolicy.contextTokens + 256) * agentPolicy.inputMicroUsdPerToken +
          agentPolicy.maxOutputTokens * agentPolicy.outputMicroUsdPerToken,
      );
      if (
        !budget ||
        budget.requests >= budget.maxRequests ||
        budget.spentMicroUsd + budget.reservedMicroUsd + reserved >
          budget.limitMicroUsd
      )
        throw new ThinkingError("limited", "Run inference budget reached.");
      await tx
        .update(agentBudgets)
        .set({
          requests: budget.requests + 1,
          reservedMicroUsd: budget.reservedMicroUsd + reserved,
        })
        .where(eq(agentBudgets.runId, runId));
      const [saved] = await tx
        .insert(modelRounds)
        .values({
          taskId: guard.taskId,
          round,
          status: "reserved",
          request,
          reservedMicroUsd: reserved,
        })
        .returning();
      return saved!;
    });
  }
  async saveAnswer(
    runId: string,
    guard: AgentGuard,
    round: number,
    answer: ModelAnswer,
  ) {
    await this.db.transaction(async (tx) => {
      const run = await this.lockRun(tx, runId);
      await assertThinkingGuard(tx, run.state, guard, false);
      const [prior] = await tx
        .select()
        .from(modelRounds)
        .where(
          and(
            eq(modelRounds.taskId, guard.taskId),
            eq(modelRounds.round, round),
          ),
        );
      if (!prior || prior.status !== "reserved") return;
      const cost = Math.ceil(
        (answer.inputTokens - answer.cachedTokens) *
          agentPolicy.inputMicroUsdPerToken +
          answer.cachedTokens * 0.075 +
          answer.outputTokens * agentPolicy.outputMicroUsdPerToken,
      );
      await tx
        .update(modelRounds)
        .set({ answer, status: "responded", costMicroUsd: cost })
        .where(
          and(
            eq(modelRounds.taskId, guard.taskId),
            eq(modelRounds.round, round),
          ),
        );
      await tx
        .update(agentBudgets)
        .set({
          reservedMicroUsd: sql`${agentBudgets.reservedMicroUsd} - ${prior.reservedMicroUsd}`,
          spentMicroUsd: sql`${agentBudgets.spentMicroUsd} + ${cost}`,
        })
        .where(eq(agentBudgets.runId, runId));
    });
  }
  async saveOutcome(
    runId: string,
    guard: AgentGuard,
    round: number,
    outcome: ToolOutcome,
  ) {
    await this.db.transaction(async (tx) => {
      const run = await this.lockRun(tx, runId);
      await assertThinkingGuard(tx, run.state, guard, false);
      await tx
        .update(modelRounds)
        .set({ status: "applied", outcome })
        .where(
          and(
            eq(modelRounds.taskId, guard.taskId),
            eq(modelRounds.round, round),
            eq(modelRounds.status, "responded"),
          ),
        );
    });
  }
  async uncertain(runId: string, guard: AgentGuard, round: number) {
    await this.db.transaction(async (tx) => {
      const run = await this.lockRun(tx, runId);
      await assertThinkingGuard(tx, run.state, guard, false);
      const [prior] = await tx
        .select()
        .from(modelRounds)
        .where(
          and(
            eq(modelRounds.taskId, guard.taskId),
            eq(modelRounds.round, round),
          ),
        );
      if (!prior || prior.status !== "reserved") return;
      await tx
        .update(modelRounds)
        .set({ status: "uncertain", costMicroUsd: prior.reservedMicroUsd })
        .where(
          and(
            eq(modelRounds.taskId, guard.taskId),
            eq(modelRounds.round, round),
          ),
        );
      await tx
        .update(agentBudgets)
        .set({
          reservedMicroUsd: sql`${agentBudgets.reservedMicroUsd} - ${prior.reservedMicroUsd}`,
          spentMicroUsd: sql`${agentBudgets.spentMicroUsd} + ${prior.reservedMicroUsd}`,
        })
        .where(eq(agentBudgets.runId, runId));
    });
  }
  async rejectRound(runId: string, guard: AgentGuard, round: number) {
    await this.db.transaction(async (tx) => {
      const run = await this.lockRun(tx, runId);
      await assertThinkingGuard(tx, run.state, guard, false);
      const [prior] = await tx
        .select()
        .from(modelRounds)
        .where(
          and(
            eq(modelRounds.taskId, guard.taskId),
            eq(modelRounds.round, round),
          ),
        );
      if (!prior || prior.status !== "reserved") return;
      await tx
        .update(modelRounds)
        .set({ status: "rejected", costMicroUsd: 0 })
        .where(
          and(
            eq(modelRounds.taskId, guard.taskId),
            eq(modelRounds.round, round),
          ),
        );
      await tx
        .update(agentBudgets)
        .set({
          reservedMicroUsd: sql`${agentBudgets.reservedMicroUsd} - ${prior.reservedMicroUsd}`,
        })
        .where(eq(agentBudgets.runId, runId));
    });
  }
  async finish(
    runId: string,
    guard: AgentGuard,
    outcome: string,
    status: "active" | "limited" | "error" = "active",
  ) {
    await this.db.transaction(async (tx) => {
      const run = await this.lockRun(tx, runId);
      await assertThinkingGuard(tx, run.state, guard, false);
      const [control] = await tx
        .select()
        .from(agentControls)
        .where(
          and(
            eq(agentControls.runId, runId),
            eq(agentControls.citizenId, guard.citizenId),
          ),
        );
      if (control?.taskId !== guard.taskId || control.version !== guard.version)
        return;
      const nextReviewAtMs = reviewDeadline(run.state, guard.citizenId);
      await tx
        .update(thinkingTurns)
        .set({ outcome, ownerId: null, leaseUntil: null })
        .where(eq(thinkingTurns.id, guard.taskId));
      await tx
        .update(backgroundTasks)
        .set({
          status: status === "active" ? "completed" : "failed",
          error: status === "active" ? null : outcome,
        })
        .where(eq(backgroundTasks.id, guard.taskId));
      await tx
        .update(agentControls)
        .set({
          taskId: null,
          nextReviewAtMs,
          lastDecisionAtMs: run.simTimeMs,
          pendingReasons: [],
          status,
          error: status === "active" ? null : outcome,
        })
        .where(
          and(
            eq(agentControls.runId, runId),
            eq(agentControls.citizenId, guard.citizenId),
          ),
        );
    });
  }
  async park(guard: AgentGuard) {
    await this.db.transaction(async (tx) => {
      const [turn] = await tx
        .select()
        .from(thinkingTurns)
        .where(
          and(
            eq(thinkingTurns.id, guard.taskId),
            eq(thinkingTurns.ownerId, guard.ownerId),
            eq(thinkingTurns.generation, guard.generation),
          ),
        )
        .for("update");
      if (!turn) return;
      await tx
        .update(thinkingTurns)
        .set({ ownerId: null, leaseUntil: null })
        .where(eq(thinkingTurns.id, guard.taskId));
      await tx
        .update(backgroundTasks)
        .set({ status: "pending" })
        .where(
          and(
            eq(backgroundTasks.id, guard.taskId),
            eq(backgroundTasks.status, "running"),
          ),
        );
    });
  }
  async candidates() {
    return this.db
      .select({ id: backgroundTasks.id })
      .from(backgroundTasks)
      .innerJoin(thinkingTurns, eq(thinkingTurns.id, backgroundTasks.id))
      .innerJoin(runs, eq(runs.id, backgroundTasks.runId))
      .innerJoin(
        agentControls,
        and(
          eq(agentControls.runId, runs.id),
          eq(agentControls.citizenId, thinkingTurns.citizenId),
        ),
      )
      .where(
        and(
          eq(backgroundTasks.kind, "agent.think"),
          inArray(backgroundTasks.status, ["pending", "queued", "running"]),
          eq(runs.status, "running"),
          eq(agentControls.status, "active"),
          sql`${agentControls.configuration}->>'provider' = 'openai'`,
          eq(agentControls.taskId, thinkingTurns.id),
          sql`not exists (select 1 from sim_thinking_turns busy join sim_background_tasks busy_task on busy_task.id = busy.id where busy_task.run_id = ${runs.id} and busy.citizen_id = ${thinkingTurns.citizenId} and busy.id <> ${thinkingTurns.id} and busy.owner_id is not null and busy.lease_until > clock_timestamp())`,
          lte(thinkingTurns.availableAtMs, runs.simTimeMs),
          or(
            isNull(thinkingTurns.leaseUntil),
            lte(thinkingTurns.leaseUntil, sql`clock_timestamp()`),
          ),
        ),
      )
      .orderBy(asc(backgroundTasks.createdAt))
      .limit(100);
  }
  async markQueued(taskId: string) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(backgroundTasks)
        .set({ status: "queued" })
        .where(
          and(
            eq(backgroundTasks.id, taskId),
            inArray(backgroundTasks.status, ["pending", "queued"]),
          ),
        );
      await tx
        .update(outbox)
        .set({ publishedAt: new Date() })
        .where(eq(outbox.taskId, taskId));
    });
  }
  async failDelivery(taskId: string) {
    const task = await this.task(taskId);
    await this.db.transaction(async (tx) => {
      await this.lockRun(tx, task.runId);
      await tx
        .update(backgroundTasks)
        .set({
          status: "failed",
          error: "Thinking delivery retries exhausted.",
        })
        .where(eq(backgroundTasks.id, taskId));
      await tx
        .update(agentControls)
        .set({
          status: "error",
          taskId: null,
          error: "Thinking delivery retries exhausted; retry explicitly.",
        })
        .where(
          and(
            eq(agentControls.runId, task.runId),
            eq(agentControls.citizenId, task.payload.citizenId),
            eq(agentControls.taskId, taskId),
          ),
        );
    });
  }
  async personalEvidence(
    runId: string,
    citizenId: string,
    before: number,
    limit = 20,
    query?: string,
  ) {
    const words =
      query
        ?.toLowerCase()
        .match(/[\p{L}\p{N}]+/gu)
        ?.slice(0, 8) ?? [];
    return (
      await this.db
        .select({ payload: observations.payload })
        .from(observations)
        .where(
          and(
            eq(observations.runId, runId),
            eq(observations.citizenId, citizenId),
            lte(observations.eventSequence, before),
            sql`${observations.payload}->>'kind' not in ('command.accepted', 'plan.updated')`,
            words.length
              ? or(
                  ...words.map(
                    (word) =>
                      sql`${observations.payload}->>'content' ilike ${`%${word}%`}`,
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(observations.eventSequence))
        .limit(limit)
    ).map((row) => row.payload);
  }
  async readEvidence(
    runId: string,
    citizenId: string,
    before: number,
    sourceId: string,
  ) {
    const [row] = await this.db
      .select({ payload: observations.payload })
      .from(observations)
      .where(
        and(
          eq(observations.runId, runId),
          eq(observations.citizenId, citizenId),
          lte(observations.eventSequence, before),
          sql`${observations.payload}->>'id' = ${sourceId}`,
        ),
      )
      .limit(1);
    return row?.payload ?? null;
  }
  async status(runId: string, citizenId: string) {
    const [control] = await this.db
      .select()
      .from(agentControls)
      .where(
        and(
          eq(agentControls.runId, runId),
          eq(agentControls.citizenId, citizenId),
        ),
      );
    if (!control) return null;
    const [budget] = await this.db
      .select()
      .from(agentBudgets)
      .where(eq(agentBudgets.runId, runId));
    const turns = await this.db
      .select({ turn: thinkingTurns, status: backgroundTasks.status })
      .from(thinkingTurns)
      .innerJoin(backgroundTasks, eq(backgroundTasks.id, thinkingTurns.id))
      .where(
        and(
          eq(backgroundTasks.runId, runId),
          eq(thinkingTurns.citizenId, citizenId),
        ),
      )
      .orderBy(desc(backgroundTasks.createdAt))
      .limit(3);
    const recent = await Promise.all(
      turns.map(async ({ turn, status }, index) => ({
        ...turn,
        context: index === 0 ? turn.context : null,
        status,
        rounds: (await this.rounds(turn.id)).map(({ request, ...round }) => ({
          ...round,
          inputTokens: request.inputTokens,
        })),
      })),
    );
    return { control, budget, turns: recent };
  }
  async retry(runId: string, citizenId: string) {
    return this.db.transaction(async (tx) => {
      const run = await this.lockRun(tx, runId);
      const [control] = await tx
        .select()
        .from(agentControls)
        .where(
          and(
            eq(agentControls.runId, runId),
            eq(agentControls.citizenId, citizenId),
          ),
        );
      if (!control || control.status === "limited")
        throw new ThinkingError(
          "limited",
          "Budget-limited runs require a new explicit run budget.",
        );
      if (control.taskId) return;
      const version = control.version + 1;
      const taskId = await enqueueThinking(tx, run.state, citizenId, version, [
        "operator-retry",
      ]);
      await tx
        .update(agentControls)
        .set({
          version,
          taskId,
          status: "active",
          pendingReasons: ["operator-retry"],
          error: null,
        })
        .where(
          and(
            eq(agentControls.runId, runId),
            eq(agentControls.citizenId, citizenId),
          ),
        );
    });
  }
}
