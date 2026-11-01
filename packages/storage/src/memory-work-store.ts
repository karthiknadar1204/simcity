import type { Database } from "@repo/db";
import {
  memoryPolicy,
  agentPolicy,
  stableStringify,
  configuredAgents,
  type AgentGuard,
  type MemoryCallRequest,
  type MemoryCallAnswer,
  type MemoryWorkGuard,
  type WorldState,
  type RunManifest,
  type MemoryTaskPayload,
} from "@repo/contracts";
import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import {
  agentBudgets,
  backgroundTasks,
  memoryTasks,
  memoryCalls,
  outbox,
  runs,
} from "@repo/db/tables";
import {
  assertThinkingGuard,
  ThinkingError,
  type Transaction,
} from "./thinking-records";
import { queueMemoryTask } from "./memory-ingest";

type WorkGuard = MemoryWorkGuard | AgentGuard;
export async function assertMemoryLease(
  tx: Transaction,
  runId: string,
  guard: MemoryWorkGuard,
) {
  const [row] = await tx
    .select({
      owner: memoryTasks.ownerId,
      generation: memoryTasks.generation,
      live: sql<boolean>`${memoryTasks.leaseUntil} > clock_timestamp()`,
      status: backgroundTasks.status,
    })
    .from(memoryTasks)
    .innerJoin(backgroundTasks, eq(backgroundTasks.id, memoryTasks.id))
    .where(
      and(eq(memoryTasks.id, guard.taskId), eq(backgroundTasks.runId, runId)),
    )
    .limit(1);
  if (
    !row ||
    row.owner !== guard.ownerId ||
    row.generation !== guard.generation ||
    !row.live ||
    row.status !== "running"
  )
    throw new ThinkingError("stale", "Memory ownership changed or expired.");
}
export interface MemoryClaim {
  guard: MemoryWorkGuard;
  payload: MemoryTaskPayload;
  state: WorldState;
  manifest: RunManifest;
}
export class MemoryWorkStore {
  constructor(readonly db: Database) {}
  private async lockRun(tx: Transaction, runId: string) {
    const [row] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, runId))
      .for("update");
    if (!row) throw new Error("Memory run not found.");
    return row;
  }
  private async checkGuard(
    tx: Transaction,
    state: WorldState,
    guard: WorkGuard,
    current = true,
  ) {
    if ("citizenId" in guard)
      await assertThinkingGuard(tx, state, guard, current);
    else await assertMemoryLease(tx, state.runId, guard);
  }
  async begin(
    taskId: string,
    ownerId: string,
    allowFixture = false,
  ): Promise<MemoryClaim | null> {
    const [task] = await this.db
      .select()
      .from(backgroundTasks)
      .where(eq(backgroundTasks.id, taskId))
      .limit(1);
    if (
      !task ||
      !task.kind.startsWith("memory.") ||
      !("operation" in task.payload)
    )
      return null;
    const payload = task.payload;
    return this.db.transaction(async (tx) => {
      const run = await this.lockRun(tx, task.runId);
      const configuration = configuredAgents(run.manifest).find(
        (item) => item.citizenId === payload.citizenId,
      );
      const [job] = await tx
        .select({
          task: memoryTasks,
          status: backgroundTasks.status,
          attempts: backgroundTasks.attempts,
          live: sql<boolean>`${memoryTasks.leaseUntil} > clock_timestamp()`,
        })
        .from(memoryTasks)
        .innerJoin(backgroundTasks, eq(backgroundTasks.id, memoryTasks.id))
        .where(eq(memoryTasks.id, taskId))
        .limit(1);
      if (
        !job ||
        !["pending", "queued", "running"].includes(job.status) ||
        !configuration?.memory ||
        (!allowFixture && configuration.provider !== "openai") ||
        (job.task.ownerId && job.live)
      )
        return null;
      if (job.attempts >= memoryPolicy.attempts) {
        await this.abandon(
          tx,
          task.runId,
          taskId,
          "Memory ownership recovery attempts exhausted.",
        );
        return null;
      }
      const [busy] = await tx
        .select({ id: memoryTasks.id })
        .from(memoryTasks)
        .innerJoin(backgroundTasks, eq(backgroundTasks.id, memoryTasks.id))
        .where(
          and(
            eq(backgroundTasks.runId, task.runId),
            eq(memoryTasks.citizenId, payload.citizenId),
            ne(memoryTasks.id, taskId),
            sql`${memoryTasks.ownerId} is not null and ${memoryTasks.leaseUntil} > clock_timestamp()`,
          ),
        )
        .limit(1);
      if (busy) return null;
      if (payload.operation === "consolidate") {
        const [pending] = await tx
          .select({ id: memoryTasks.id })
          .from(memoryTasks)
          .innerJoin(backgroundTasks, eq(backgroundTasks.id, memoryTasks.id))
          .where(
            and(
              eq(backgroundTasks.runId, task.runId),
              eq(memoryTasks.citizenId, payload.citizenId),
              eq(memoryTasks.operation, "extract"),
              lte(memoryTasks.cutoff, payload.cutoff),
              inArray(backgroundTasks.status, ["pending", "queued", "running"]),
            ),
          )
          .limit(1);
        if (pending) return null;
      }
      const generation = job.task.generation + 1;
      await tx
        .update(memoryTasks)
        .set({
          ownerId,
          generation,
          leaseUntil: sql`clock_timestamp() + ${memoryPolicy.leaseMs} * interval '1 millisecond'`,
        })
        .where(eq(memoryTasks.id, taskId));
      await tx
        .update(backgroundTasks)
        .set({
          status: "running",
          attempts: sql`${backgroundTasks.attempts} + 1`,
        })
        .where(eq(backgroundTasks.id, taskId));
      return {
        guard: { taskId, ownerId, generation },
        payload,
        state: run.state,
        manifest: run.manifest,
      };
    });
  }
  async heartbeat(guard: MemoryWorkGuard) {
    const rows = await this.db
      .update(memoryTasks)
      .set({
        leaseUntil: sql`clock_timestamp() + ${memoryPolicy.leaseMs} * interval '1 millisecond'`,
      })
      .where(
        and(
          eq(memoryTasks.id, guard.taskId),
          eq(memoryTasks.ownerId, guard.ownerId),
          eq(memoryTasks.generation, guard.generation),
          sql`${memoryTasks.leaseUntil} > clock_timestamp()`,
        ),
      )
      .returning({ id: memoryTasks.id });
    return rows.length === 1;
  }
  async reserveCall(
    runId: string,
    citizenId: string,
    guard: WorkGuard,
    step: string,
    request: MemoryCallRequest,
  ) {
    return this.db.transaction(async (tx) => {
      const run = await this.lockRun(tx, runId);
      await this.checkGuard(tx, run.state, guard);
      const [task] = await tx
        .select()
        .from(backgroundTasks)
        .where(
          and(
            eq(backgroundTasks.id, guard.taskId),
            eq(backgroundTasks.runId, runId),
          ),
        )
        .limit(1);
      if (
        !task ||
        !("citizenId" in task.payload) ||
        task.payload.citizenId !== citizenId
      )
        throw new Error("Wrong citizen in model work.");
      const [prior] = await tx
        .select()
        .from(memoryCalls)
        .where(
          and(eq(memoryCalls.taskId, guard.taskId), eq(memoryCalls.step, step)),
        )
        .limit(1);
      if (prior) {
        if (stableStringify(prior.request) !== stableStringify(request))
          throw new Error(
            "Model operation identity reused with different input.",
          );
        return prior;
      }
      const embedding = request.kind === "embed" || request.kind === "query";
      if (
        request.model !==
          (embedding
            ? memoryPolicy.embeddingModel
            : memoryPolicy.extractionModel) ||
        request.inputTokens > memoryPolicy.maxInputTokens ||
        request.inputTokens < 0
      )
        throw new ThinkingError(
          "limited",
          "Memory model or input exceeds its policy.",
        );
      const reservedMicroUsd = Math.ceil(
        (request.inputTokens + 128) *
          (embedding
            ? memoryPolicy.embeddingMicroUsdPerToken
            : agentPolicy.inputMicroUsdPerToken) +
          (embedding
            ? 0
            : memoryPolicy.maxOutputTokens *
              agentPolicy.outputMicroUsdPerToken),
      );
      const [budget] = await tx
        .select()
        .from(agentBudgets)
        .where(eq(agentBudgets.runId, runId))
        .limit(1);
      if (
        !budget ||
        budget.requests >= budget.maxRequests ||
        budget.spentMicroUsd + budget.reservedMicroUsd + reservedMicroUsd >
          budget.limitMicroUsd
      )
        throw new ThinkingError(
          "limited",
          "Run model budget exhausted during memory work.",
        );
      await tx
        .update(agentBudgets)
        .set({
          requests: sql`${agentBudgets.requests} + 1`,
          reservedMicroUsd: sql`${agentBudgets.reservedMicroUsd} + ${reservedMicroUsd}`,
        })
        .where(eq(agentBudgets.runId, runId));
      const [record] = await tx
        .insert(memoryCalls)
        .values({
          taskId: guard.taskId,
          step,
          runId,
          citizenId,
          request,
          reservedMicroUsd,
          status: "reserved",
        })
        .returning();
      return record!;
    });
  }
  async saveAnswer(
    runId: string,
    guard: WorkGuard,
    step: string,
    answer: MemoryCallAnswer,
  ) {
    await this.db.transaction(async (tx) => {
      const run = await this.lockRun(tx, runId);
      await this.checkGuard(tx, run.state, guard, false);
      const [prior] = await tx
        .select()
        .from(memoryCalls)
        .where(
          and(eq(memoryCalls.taskId, guard.taskId), eq(memoryCalls.step, step)),
        )
        .limit(1);
      if (!prior || prior.status !== "reserved") return;
      const embedding =
        prior.request.kind === "embed" || prior.request.kind === "query";
      const costMicroUsd = Math.ceil(
        embedding
          ? answer.inputTokens * memoryPolicy.embeddingMicroUsdPerToken
          : Math.max(0, answer.inputTokens - answer.cachedTokens) *
              agentPolicy.inputMicroUsdPerToken +
              answer.cachedTokens * 0.075 +
              answer.outputTokens * agentPolicy.outputMicroUsdPerToken,
      );
      await tx
        .update(memoryCalls)
        .set({ answer, status: "responded", costMicroUsd })
        .where(
          and(eq(memoryCalls.taskId, guard.taskId), eq(memoryCalls.step, step)),
        );
      await tx
        .update(agentBudgets)
        .set({
          reservedMicroUsd: sql`${agentBudgets.reservedMicroUsd} - ${prior.reservedMicroUsd}`,
          spentMicroUsd: sql`${agentBudgets.spentMicroUsd} + ${costMicroUsd}`,
        })
        .where(eq(agentBudgets.runId, runId));
    });
  }
  async settleFailure(
    runId: string,
    guard: WorkGuard,
    step: string,
    rejected: boolean,
  ) {
    await this.db.transaction(async (tx) => {
      const run = await this.lockRun(tx, runId);
      await this.checkGuard(tx, run.state, guard, false);
      const [prior] = await tx
        .select()
        .from(memoryCalls)
        .where(
          and(eq(memoryCalls.taskId, guard.taskId), eq(memoryCalls.step, step)),
        )
        .limit(1);
      if (!prior || prior.status !== "reserved") return;
      const costMicroUsd = rejected ? 0 : prior.reservedMicroUsd;
      await tx
        .update(memoryCalls)
        .set({
          status: rejected ? "rejected" : "uncertain",
          costMicroUsd,
          error: rejected
            ? "Provider rejected the request; no inference usage recorded."
            : "Request delivery uncertain; reserved estimate retained.",
        })
        .where(
          and(eq(memoryCalls.taskId, guard.taskId), eq(memoryCalls.step, step)),
        );
      await tx
        .update(agentBudgets)
        .set({
          reservedMicroUsd: sql`${agentBudgets.reservedMicroUsd} - ${prior.reservedMicroUsd}`,
          spentMicroUsd: sql`${agentBudgets.spentMicroUsd} + ${costMicroUsd}`,
        })
        .where(eq(agentBudgets.runId, runId));
    });
  }
  async call(taskId: string, step: string) {
    const [row] = await this.db
      .select()
      .from(memoryCalls)
      .where(and(eq(memoryCalls.taskId, taskId), eq(memoryCalls.step, step)))
      .limit(1);
    return row ?? null;
  }
  async release(guard: MemoryWorkGuard) {
    await this.db
      .update(memoryTasks)
      .set({ ownerId: null, leaseUntil: null })
      .where(
        and(
          eq(memoryTasks.id, guard.taskId),
          eq(memoryTasks.ownerId, guard.ownerId),
          eq(memoryTasks.generation, guard.generation),
        ),
      );
  }
  async finish(runId: string, guard: MemoryWorkGuard, error?: string) {
    await this.db.transaction(async (tx) => {
      await this.lockRun(tx, runId);
      await assertMemoryLease(tx, runId, guard);
      await tx
        .update(backgroundTasks)
        .set({ status: error ? "failed" : "completed", error: error ?? null })
        .where(eq(backgroundTasks.id, guard.taskId));
      await tx
        .update(memoryTasks)
        .set({ ownerId: null, leaseUntil: null })
        .where(eq(memoryTasks.id, guard.taskId));
    });
  }
  async candidates(allowFixtures = false, runId?: string) {
    return this.db
      .select({ id: memoryTasks.id, operation: memoryTasks.operation })
      .from(memoryTasks)
      .innerJoin(backgroundTasks, eq(backgroundTasks.id, memoryTasks.id))
      .innerJoin(runs, eq(runs.id, backgroundTasks.runId))
      .where(
        and(
          inArray(backgroundTasks.status, ["pending", "queued", "running"]),
          sql`exists (select 1 from jsonb_array_elements(coalesce(${runs.manifest}->'agents',jsonb_build_array(${runs.manifest}->'agent'))) cfg where cfg->>'citizenId' = ${memoryTasks.citizenId} and cfg->>'memory' = 'true' ${allowFixtures ? sql`` : sql`and cfg->>'provider' = 'openai'`})`,
          runId ? eq(runs.id, runId) : undefined,
          or(
            isNull(memoryTasks.leaseUntil),
            lte(memoryTasks.leaseUntil, sql`clock_timestamp()`),
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
    const [task] = await this.db
      .select()
      .from(backgroundTasks)
      .where(eq(backgroundTasks.id, taskId))
      .limit(1);
    if (!task || !task.kind.startsWith("memory.")) return;
    await this.db.transaction(async (tx) => {
      await this.lockRun(tx, task.runId);
      const [current] = await tx
        .select({
          status: backgroundTasks.status,
          live: sql<boolean>`${memoryTasks.leaseUntil} > clock_timestamp()`,
        })
        .from(backgroundTasks)
        .innerJoin(memoryTasks, eq(memoryTasks.id, backgroundTasks.id))
        .where(eq(backgroundTasks.id, taskId));
      if (
        !current ||
        current.live ||
        !["pending", "queued", "running"].includes(current.status)
      )
        return;
      await this.abandon(
        tx,
        task.runId,
        taskId,
        "Memory queue delivery retries exhausted.",
      );
    });
  }
  private async abandon(
    tx: Transaction,
    runId: string,
    taskId: string,
    error: string,
  ) {
    const pending = await tx
      .select()
      .from(memoryCalls)
      .where(
        and(eq(memoryCalls.taskId, taskId), eq(memoryCalls.status, "reserved")),
      );
    const held = pending.reduce((sum, call) => sum + call.reservedMicroUsd, 0);
    if (pending.length) {
      await tx
        .update(memoryCalls)
        .set({
          status: "uncertain",
          costMicroUsd: sql`${memoryCalls.reservedMicroUsd}`,
          error:
            "Abandoned delivery; reserved estimate charged conservatively.",
        })
        .where(
          and(
            eq(memoryCalls.taskId, taskId),
            eq(memoryCalls.status, "reserved"),
          ),
        );
      await tx
        .update(agentBudgets)
        .set({
          reservedMicroUsd: sql`${agentBudgets.reservedMicroUsd} - ${held}`,
          spentMicroUsd: sql`${agentBudgets.spentMicroUsd} + ${held}`,
        })
        .where(eq(agentBudgets.runId, runId));
    }
    await tx
      .update(backgroundTasks)
      .set({ status: "failed", error })
      .where(eq(backgroundTasks.id, taskId));
    await tx
      .update(memoryTasks)
      .set({ ownerId: null, leaseUntil: null })
      .where(eq(memoryTasks.id, taskId));
  }
  async retry(taskId: string) {
    return this.db.transaction(async (tx) => {
      const [task] = await tx
        .select()
        .from(backgroundTasks)
        .where(eq(backgroundTasks.id, taskId))
        .limit(1);
      if (!task || task.status !== "failed" || !("operation" in task.payload))
        throw new Error("Only failed memory work can be explicitly retried.");
      await this.lockRun(tx, task.runId);
      return queueMemoryTask(tx, { ...task.payload, retryOf: taskId });
    });
  }
  async status(runId: string, citizenId: string) {
    const jobs = await this.db
      .select({
        task: memoryTasks,
        status: backgroundTasks.status,
        attempts: backgroundTasks.attempts,
        error: backgroundTasks.error,
      })
      .from(memoryTasks)
      .innerJoin(backgroundTasks, eq(backgroundTasks.id, memoryTasks.id))
      .where(
        and(
          eq(backgroundTasks.runId, runId),
          eq(memoryTasks.citizenId, citizenId),
        ),
      )
      .orderBy(sql`${backgroundTasks.createdAt} desc`)
      .limit(20);
    return Promise.all(
      jobs.map(async (job) => ({
        ...job,
        calls: await this.db
          .select({
            step: memoryCalls.step,
            status: memoryCalls.status,
            request: memoryCalls.request,
            costMicroUsd: memoryCalls.costMicroUsd,
            error: memoryCalls.error,
          })
          .from(memoryCalls)
          .where(eq(memoryCalls.taskId, job.task.id))
          .limit(3),
      })),
    );
  }
}
