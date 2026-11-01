import type { Database } from "@repo/db";
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  backgroundTasks,
  commitmentVersions,
  events,
  memories,
  memoryEdges,
  memoryIndexes,
  memoryStreams,
  memoryTasks,
  memoryCalls,
  runs,
  agentControls,
  thinkingTurns,
} from "@repo/db/tables";
import {
  contentHash,
  stableStringify,
  memoryExtractionSchema,
  memoryPolicy,
  type CommitmentRecord,
  type MemoryCallAnswer,
  type MemoryRecord,
  type MemorySource,
  type MemoryTaskPayload,
  type MemoryWorkGuard,
  type WorldEvent,
  type WorldState,
} from "@repo/contracts";
import {
  validateAgreement,
  validateClaim,
  validateQuotes,
  normalizeAgreementCalendar,
  normalizeAgreementReference,
} from "@repo/memory";
import { applyEvent } from "@repo/engine";
import { assertMemoryLease } from "./memory-work-store";
import { MemoryStore } from "./memory-store";
import { putMemory, queueMemoryTask } from "./memory-ingest";
import { enqueueThinking, type Transaction } from "./thinking-records";
import { reconcileFulfillments } from "./memory-commitments";

async function notify(tx: Transaction, state: WorldState, citizenId: string) {
  const self = state.citizens[citizenId]!;
  if (self.actionId && state.jobs[self.actionId]?.kind === "sleep") return;
  const where = and(
    eq(agentControls.runId, state.runId),
    eq(agentControls.citizenId, citizenId),
  );
  const [control] = await tx.select().from(agentControls).where(where).limit(1);
  if (!control || control.status !== "active") return;
  const [current] = control.taskId
    ? await tx
        .select()
        .from(thinkingTurns)
        .where(eq(thinkingTurns.id, control.taskId))
        .limit(1)
    : [];
  const reasons = [
    ...new Set([...control.pendingReasons, "memory-updated"]),
  ].slice(-10);
  if (current && current.boundarySequence === null) {
    await tx
      .update(thinkingTurns)
      .set({ reasons })
      .where(eq(thinkingTurns.id, current.id));
    await tx
      .update(agentControls)
      .set({ pendingReasons: reasons })
      .where(where);
    return;
  }
  if (current) {
    await tx
      .update(backgroundTasks)
      .set({ status: "superseded" })
      .where(eq(backgroundTasks.id, current.id));
    await tx
      .update(thinkingTurns)
      .set({ outcome: "superseded by published memory" })
      .where(eq(thinkingTurns.id, current.id));
  }
  const version = control.version + 1;
  const taskId = await enqueueThinking(tx, state, citizenId, version, reasons);
  await tx
    .update(agentControls)
    .set({ taskId, version, pendingReasons: reasons })
    .where(where);
}

async function publishBoundary(
  tx: Transaction,
  before: WorldState,
  guard: MemoryWorkGuard,
  citizenId: string,
  indexed = false,
) {
  const event: WorldEvent = {
    sequence: before.sequence + 1,
    simTimeMs: before.simTimeMs,
    kind: indexed ? "memory.indexed" : "memory.published",
    description: indexed
      ? "A personal search index became available."
      : "A personal memory interpretation became available.",
    actorId: citizenId,
    audienceIds: [citizenId],
    position: null,
    causeId: guard.taskId,
    patch: {},
  };
  const state = applyEvent(before, event);
  await tx.insert(events).values({
    runId: before.runId,
    sequence: event.sequence,
    simTimeMs: event.simTimeMs,
    payload: event,
  });
  await tx
    .update(runs)
    .set({
      state,
      stateHash: await contentHash(state),
      sequence: state.sequence,
    })
    .where(eq(runs.id, state.runId));
  return state;
}

async function complete(
  tx: Transaction,
  guard: MemoryWorkGuard,
  accepted: number,
  rejected: string[],
) {
  await tx
    .update(backgroundTasks)
    .set({ status: "completed", error: null })
    .where(eq(backgroundTasks.id, guard.taskId));
  await tx
    .update(memoryTasks)
    .set({ ownerId: null, leaseUntil: null, outcome: { accepted, rejected } })
    .where(eq(memoryTasks.id, guard.taskId));
}

export async function publishMemoryAnswer(
  db: Database,
  guard: MemoryWorkGuard,
  payload: MemoryTaskPayload,
  answer: MemoryCallAnswer,
) {
  const reader = new MemoryStore(db);
  const [saved] = await db
    .select()
    .from(memoryCalls)
    .where(
      and(eq(memoryCalls.taskId, guard.taskId), eq(memoryCalls.step, "main")),
    )
    .limit(1);
  if (
    !saved ||
    saved.status !== "responded" ||
    stableStringify(saved.answer) !== stableStringify(answer) ||
    saved.request.kind !== payload.operation
  )
    throw new Error(
      "A matching durable model response is required before publication.",
    );
  const [sourceMemory] = payload.memoryId
    ? await db
        .select()
        .from(memories)
        .where(
          and(
            eq(memories.id, payload.memoryId),
            eq(memories.runId, payload.runId),
            eq(memories.citizenId, payload.citizenId),
            sql`${memories.availableSequence} <= ${payload.cutoff}`,
          ),
        )
        .limit(1)
    : [];
  if (payload.memoryId && !sourceMemory)
    throw new Error("Memory source version is unavailable.");
  if (payload.operation === "embed") {
    const vector = answer.data;
    if (
      !Array.isArray(vector) ||
      vector.length !== memoryPolicy.dimensions ||
      vector.some((value) => !Number.isFinite(value)) ||
      answer.model !== memoryPolicy.embeddingModel ||
      (await contentHash(saved.request.input)) !== sourceMemory!.textHash
    )
      throw new Error("Embedding response does not match the index contract.");
    return db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(runs)
        .where(eq(runs.id, payload.runId))
        .for("update");
      if (!run || (await contentHash(run.state)) !== run.stateHash)
        throw new Error("Memory publication world hash mismatch.");
      await assertMemoryLease(tx, payload.runId, guard);
      const state = await publishBoundary(
        tx,
        run.state,
        guard,
        payload.citizenId,
        true,
      );
      await tx
        .update(memoryIndexes)
        .set({
          embedding: vector,
          status: "ready",
          availableSequence: state.sequence,
        })
        .where(
          and(
            eq(memoryIndexes.memoryId, sourceMemory!.id),
            eq(memoryIndexes.textHash, sourceMemory!.textHash),
            eq(memoryIndexes.model, answer.model),
            eq(memoryIndexes.dimensions, memoryPolicy.dimensions),
          ),
        );
      await complete(tx, guard, 1, []);
      return {
        sequence: state.sequence,
        accepted: 1,
        rejected: [] as string[],
      };
    });
  }
  const extraction = memoryExtractionSchema.parse(answer.data);
  const priorCommitments = await reader.commitments(
    payload.runId,
    payload.citizenId,
    payload.cutoff,
    100,
  );
  const requestInput = JSON.parse(saved.request.input) as {
    sources?: MemorySource[];
    memoryIds?: string[];
    coverageCutoff?: number;
  };
  const inputMemories = sourceMemory
    ? [sourceMemory]
    : requestInput.memoryIds?.length
      ? await db
          .select()
          .from(memories)
          .where(
            and(
              eq(memories.runId, payload.runId),
              eq(memories.citizenId, payload.citizenId),
              inArray(memories.id, requestInput.memoryIds.slice(0, 12)),
              lte(memories.availableSequence, payload.cutoff),
              or(
                isNull(memories.supersededSequence),
                gt(memories.supersededSequence, payload.cutoff),
              ),
            ),
          )
      : [];
  const coverageCutoff = sourceMemory
    ? payload.cutoff
    : Math.max(0, ...inputMemories.map((item) => item.sourceCutoff));
  if (
    payload.operation === "consolidate" &&
    (!inputMemories.length ||
      requestInput.coverageCutoff !== coverageCutoff ||
      coverageCutoff > payload.cutoff)
  )
    throw new Error(
      "Consolidation coverage does not match its supplied memory versions.",
    );
  const suppliedIds = new Set(
    (requestInput.sources ?? []).map((source) => source.id),
  );
  const inputIds = [
    ...new Set([
      ...inputMemories.flatMap((item) => item.sourceIds),
      ...priorCommitments.flatMap((item) => item.sourceIds),
    ]),
  ]
    .filter((id) => suppliedIds.has(id))
    .slice(0, 100);
  const sources = await reader.sources(
    payload.runId,
    payload.citizenId,
    payload.cutoff,
    inputIds,
  );
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(runs)
      .where(eq(runs.id, payload.runId))
      .for("update");
    if (!run || (await contentHash(run.state)) !== run.stateHash)
      throw new Error("Memory publication world hash mismatch.");
    await assertMemoryLease(tx, payload.runId, guard);
    const state = await publishBoundary(
      tx,
      run.state,
      guard,
      payload.citizenId,
    );
    const availableSequence = state.sequence,
      rejected: string[] = [];
    let accepted = 0;
    const write = async (
      logicalId: string,
      kind: MemoryRecord["kind"],
      title: string,
      text: string,
      evidence: MemorySource[],
      extra: Record<string, unknown> = {},
    ) => {
      const sourceIds = [...new Set(evidence.map((source) => source.id))];
      const raw = evidence
        .map((source) => `[${source.simTimeMs}] ${source.content}`)
        .join("\n");
      const memory = await putMemory(tx, {
        runId: payload.runId,
        citizenId: payload.citizenId,
        logicalId,
        kind,
        certainty: kind === "proposal" ? "tentative" : "inferred",
        title,
        text,
        searchText: `${raw}\nInterpretation: ${text}`,
        sourceIds,
        entityIds: [
          ...new Set(
            evidence.flatMap((source) => [
              ...source.entityIds,
              ...source.participantIds,
            ]),
          ),
        ],
        eventStartMs: Math.min(...evidence.map((source) => source.simTimeMs)),
        eventEndMs: Math.max(...evidence.map((source) => source.simTimeMs)),
        sourceCutoff: payload.cutoff,
        availableSequence,
        payload: {
          ...extra,
          sourceCutoff: payload.cutoff,
          interpretation: true,
        },
      });
      if (memory.availableSequence !== availableSequence) return memory;
      if (sourceMemory)
        await tx
          .insert(memoryEdges)
          .values({
            runId: payload.runId,
            citizenId: payload.citizenId,
            fromId: memory.id,
            toId: sourceMemory.id,
            relation: "summarizes",
          })
          .onConflictDoNothing();
      else if (inputMemories.length)
        await tx
          .insert(memoryEdges)
          .values(
            inputMemories.map((item) => ({
              runId: payload.runId,
              citizenId: payload.citizenId,
              fromId: memory.id,
              toId: item.id,
              relation: "summarizes" as const,
            })),
          )
          .onConflictDoNothing();
      await queueMemoryTask(tx, {
        ...payload,
        memoryId: memory.id,
        operation: "embed",
        cutoff: availableSequence,
        retryOf: undefined,
        parentTaskId: guard.taskId,
      });
      accepted++;
      return memory;
    };
    let supporting: MemorySource[] | null = null;
    try {
      supporting = validateQuotes(
        extraction.summaryEvidence,
        sources,
        payload.citizenId,
        payload.cutoff,
      );
    } catch (error) {
      rejected.push(
        `summary: ${error instanceof Error ? error.message : "invalid evidence"}`,
      );
    }
    if (supporting) {
      await write(
        sourceMemory
          ? `summary:${sourceMemory.logicalId}`
          : `consolidation:${payload.cutoff}:${coverageCutoff}`,
        payload.operation === "consolidate" ? "reflection" : "episode",
        extraction.title,
        extraction.summary,
        supporting,
        {
          coveredSourceIds: supporting.map((source) => source.id),
          memberIds: inputMemories.map((item) => item.id),
        },
      );
      if (sourceMemory)
        await tx
          .update(memoryIndexes)
          .set({ status: "superseded" })
          .where(
            and(
              eq(memoryIndexes.memoryId, sourceMemory.id),
              eq(memoryIndexes.status, "pending"),
            ),
          );
    }
    for (const [index, proposed] of extraction.agreements.entries()) {
      if (payload.operation === "consolidate") {
        rejected.push(
          `agreement ${index}: Consolidation cannot create agreements.`,
        );
        continue;
      }
      const proposedId = `c-${await contentHash({ runId: payload.runId, citizenId: payload.citizenId, originSourceId: proposed.originSourceId })}`;
      const [existing] = await tx
        .select()
        .from(commitmentVersions)
        .where(
          and(
            eq(commitmentVersions.runId, payload.runId),
            eq(commitmentVersions.citizenId, payload.citizenId),
            eq(
              commitmentVersions.logicalId,
              proposed.commitmentId ?? proposedId,
            ),
            isNull(commitmentVersions.supersededSequence),
          ),
        )
        .orderBy(desc(commitmentVersions.version))
        .limit(1);
      const logicalId = existing?.logicalId ?? proposedId;
      let checked: ReturnType<typeof validateAgreement>;
      let candidate: typeof proposed;
      try {
        candidate = normalizeAgreementCalendar(
          normalizeAgreementReference(proposed, existing ?? null),
          sources,
          payload.citizenId,
          payload.cutoff,
          state.rules.dayLengthMs,
          existing ?? null,
        );
        checked = validateAgreement(
          candidate,
          sources,
          payload.citizenId,
          payload.cutoff,
          state.rules.dayLengthMs,
          existing ?? null,
        );
        if (checked.accepted && existing && existing.status !== "accepted")
          throw new Error(
            "Closed commitments require a new agreement, not a silent amendment.",
          );
        if (checked.accepted && existing && candidate.operation === "agree") {
          if (
            candidate.amount === existing.amount &&
            candidate.deadlineMs === existing.deadlineMs
          )
            continue;
          throw new Error("Changed terms require an accepted amendment.");
        }
      } catch (error) {
        rejected.push(
          `agreement ${index}: ${error instanceof Error ? error.message : "invalid evidence"}`,
        );
        continue;
      }
      if (!checked.accepted) {
        if (
          existing &&
          candidate.proposal.sourceId === existing.originSourceId &&
          checked.effectiveSequence <= existing.effectiveSequence &&
          candidate.amount === existing.amount &&
          candidate.deadlineMs === existing.deadlineMs
        )
          continue;
        await write(
          `proposal:${candidate.originSourceId}:${candidate.operation}`,
          "proposal",
          "Unaccepted or uncertain proposal",
          candidate.proposal.quote,
          sources.filter((source) => checked.sourceIds.includes(source.id)),
          {
            candidate,
            originSourceId: candidate.originSourceId,
            status: "proposed",
          },
        );
        continue;
      }
      if (existing && checked.effectiveSequence <= existing.effectiveSequence)
        continue;
      const version = (existing?.version ?? 0) + 1;
      const record: CommitmentRecord = {
        id: `cv-${await contentHash({ logicalId, version })}`,
        logicalId,
        version,
        runId: payload.runId,
        citizenId: payload.citizenId,
        debtorId: candidate.debtorId,
        creditorId: candidate.creditorId,
        resource: candidate.resource,
        amount: candidate.amount,
        deadlineMs: candidate.deadlineMs,
        status: candidate.operation === "cancel" ? "cancelled" : "accepted",
        originSourceId: candidate.originSourceId,
        sourceIds: [
          ...new Set([candidate.originSourceId, ...checked.sourceIds]),
        ],
        effectiveSequence: checked.effectiveSequence,
        availableSequence,
        supersededSequence: null,
      };
      if (existing)
        await tx
          .update(commitmentVersions)
          .set({ supersededSequence: availableSequence })
          .where(eq(commitmentVersions.id, existing.id));
      await tx.insert(commitmentVersions).values(record);
      await tx
        .update(memories)
        .set({ supersededSequence: availableSequence })
        .where(
          and(
            eq(memories.runId, payload.runId),
            eq(memories.citizenId, payload.citizenId),
            eq(memories.kind, "proposal"),
            sql`${memories.payload}->>'originSourceId' = ${candidate.originSourceId}`,
            isNull(memories.supersededSequence),
          ),
        );
      await write(
        `agreement:${logicalId}`,
        "episode",
        "Agreement terms as recorded",
        JSON.stringify({
          status: record.status,
          debtorId: record.debtorId,
          creditorId: record.creditorId,
          resource: record.resource,
          amount: record.amount,
          deadlineMs: record.deadlineMs,
          effectiveSequence: record.effectiveSequence,
        }),
        sources.filter((source) => record.sourceIds.includes(source.id)),
        {
          commitmentId: record.logicalId,
          commitmentVersionId: record.id,
          calendarNormalization: {
            modelDeadlineMs: proposed.deadlineMs,
            canonicalDeadlineMs: record.deadlineMs,
            basis: "exact source clock and simulation day",
          },
          identityNormalization: {
            modelOriginSourceId: proposed.originSourceId,
            canonicalOriginSourceId: candidate.originSourceId,
          },
          projectIds: [`commitment:${record.logicalId}`],
        },
      );
      accepted++;
    }
    for (const [index, candidate] of extraction.claims.entries()) {
      let evidence: string[];
      try {
        evidence = validateClaim(
          candidate,
          sources,
          payload.citizenId,
          payload.cutoff,
        );
      } catch (error) {
        rejected.push(
          `claim ${index}: ${error instanceof Error ? error.message : "invalid evidence"}`,
        );
        continue;
      }
      const logicalId = `claim-${await contentHash({ kind: candidate.kind, entityIds: [...candidate.entityIds].sort(), title: candidate.title.toLowerCase() })}`;
      await write(
        logicalId,
        candidate.kind,
        candidate.title,
        candidate.text,
        sources.filter((source) => evidence.includes(source.id)),
        {
          qualified: true,
          evidence: candidate.evidence,
          routine: candidate.routine,
        },
      );
    }
    if (sourceMemory && accepted === 0) {
      await queueMemoryTask(tx, {
        ...payload,
        memoryId: sourceMemory.id,
        operation: "embed",
        cutoff: availableSequence,
        retryOf: undefined,
      });
    }
    if (payload.operation === "consolidate" && accepted) {
      const [more] = await tx
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.runId, payload.runId),
            eq(memories.citizenId, payload.citizenId),
            eq(memories.kind, "episode"),
            sql`${memories.payload}->>'raw' = 'true'`,
            lte(memories.availableSequence, payload.cutoff),
            or(
              isNull(memories.supersededSequence),
              gt(memories.supersededSequence, payload.cutoff),
            ),
            gt(memories.sourceCutoff, coverageCutoff),
          ),
        )
        .limit(1);
      const covered = more ? coverageCutoff : payload.cutoff;
      await tx
        .update(memoryStreams)
        .set({
          consolidatedCutoff: sql`greatest(${memoryStreams.consolidatedCutoff}, ${covered})`,
        })
        .where(
          and(
            eq(memoryStreams.runId, payload.runId),
            eq(memoryStreams.citizenId, payload.citizenId),
          ),
        );
      if (more)
        await queueMemoryTask(tx, {
          runId: payload.runId,
          citizenId: payload.citizenId,
          memoryId: null,
          cutoff: payload.cutoff,
          operation: "consolidate",
          parentTaskId: guard.taskId,
        });
    }
    if (payload.operation === "extract")
      accepted += await reconcileFulfillments(
        tx,
        payload.runId,
        payload.citizenId,
        availableSequence,
      );
    await complete(tx, guard, accepted, rejected);
    if (payload.operation === "consolidate" && !accepted)
      await tx
        .update(backgroundTasks)
        .set({
          status: "failed",
          error:
            "Consolidation produced no valid interpretation; originals retained.",
        })
        .where(eq(backgroundTasks.id, guard.taskId));
    if (accepted) await notify(tx, state, payload.citizenId);
    return { sequence: availableSequence, accepted, rejected };
  });
}
