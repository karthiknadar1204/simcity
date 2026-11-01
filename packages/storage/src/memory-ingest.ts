import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  backgroundTasks,
  memories,
  memoryEntities,
  memoryIndexes,
  memorySessions,
  memoryMembers,
  memoryStreams,
  memoryTasks,
  memoryEdges,
  outbox,
} from "@repo/db/tables";
import {
  contentHash,
  memoryPolicy,
  type MemoryRecord,
  type MemorySource,
  type MemoryTaskPayload,
  type Transition,
  type WorldState,
} from "@repo/contracts";
import { episodeKey } from "@repo/memory";
import type { Transaction } from "./thinking-records";

export async function queueMemoryTask(
  tx: Transaction,
  payload: MemoryTaskPayload,
) {
  const id = `mt-${await contentHash(payload)}`;
  const inserted = await tx
    .insert(backgroundTasks)
    .values({
      id,
      runId: payload.runId,
      kind: `memory.${payload.operation}`,
      payload,
      status: "pending",
    })
    .onConflictDoNothing()
    .returning({ id: backgroundTasks.id });
  if (inserted.length) {
    await tx
      .insert(memoryTasks)
      .values({
        id,
        citizenId: payload.citizenId,
        operation: payload.operation,
        memoryId: payload.memoryId,
        cutoff: payload.cutoff,
      });
    await tx.insert(outbox).values({ taskId: id });
  }
  return id;
}

export async function putMemory(
  tx: Transaction,
  input: Omit<
    MemoryRecord,
    "id" | "version" | "textHash" | "supersededSequence"
  >,
) {
  const [prior] = await tx
    .select()
    .from(memories)
    .where(
      and(
        eq(memories.runId, input.runId),
        eq(memories.citizenId, input.citizenId),
        eq(memories.logicalId, input.logicalId),
        isNull(memories.supersededSequence),
      ),
    )
    .orderBy(desc(memories.version))
    .limit(1);
  if (prior && prior.sourceCutoff > input.sourceCutoff) return prior;
  const textHash = await contentHash(input.searchText);
  if (
    prior &&
    prior.textHash === textHash &&
    prior.sourceCutoff === input.sourceCutoff
  )
    return prior;
  const version = (prior?.version ?? 0) + 1;
  const record: MemoryRecord = {
    ...input,
    id: `m-${await contentHash({ runId: input.runId, citizenId: input.citizenId, logicalId: input.logicalId, version })}`,
    version,
    textHash,
    supersededSequence: null,
  };
  if (prior)
    await tx
      .update(memories)
      .set({ supersededSequence: input.availableSequence })
      .where(eq(memories.id, prior.id));
  await tx.insert(memories).values(record);
  if (input.entityIds.length)
    await tx
      .insert(memoryEntities)
      .values(
        [...new Set(input.entityIds)].map((entityId) => ({
          memoryId: record.id,
          runId: input.runId,
          citizenId: input.citizenId,
          entityId,
        })),
      );
  await tx
    .insert(memoryIndexes)
    .values({
      memoryId: record.id,
      status: "pending",
      model: memoryPolicy.embeddingModel,
      dimensions: memoryPolicy.dimensions,
      textHash,
    });
  if (prior)
    await tx
      .insert(memoryEdges)
      .values({
        runId: input.runId,
        citizenId: input.citizenId,
        fromId: record.id,
        toId: prior.id,
        relation: "supersedes",
      })
      .onConflictDoNothing();
  return record;
}

export async function initializeMemories(
  tx: Transaction,
  state: WorldState,
  citizenId: string,
) {
  await tx
    .insert(memoryStreams)
    .values({ runId: state.runId, citizenId })
    .onConflictDoNothing();
  const self = state.citizens[citizenId]!;
  for (const [index, text] of self.initialMemories.entries()) {
    const source: MemorySource = {
      id: `seed-${index}`,
      citizenId,
      sequence: 0,
      simTimeMs: 0,
      kind: "seed",
      content: text,
      actorId: citizenId,
      participantIds: [citizenId],
      entityIds: [],
    };
    const memory = await putMemory(tx, {
      runId: state.runId,
      citizenId,
      logicalId: source.id,
      kind: "episode",
      certainty: "reported",
      title: "Initial personal memory",
      text,
      searchText: text,
      sourceIds: [source.id],
      entityIds: [],
      eventStartMs: 0,
      eventEndMs: 0,
      sourceCutoff: 0,
      availableSequence: 0,
      payload: { sources: [source], seed: true },
    });
    await queueMemoryTask(tx, {
      runId: state.runId,
      citizenId,
      memoryId: memory.id,
      cutoff: 0,
      operation: "embed",
    });
  }
}

const significant = new Set([
  "speech.delivered",
  "action.started",
  "action.completed",
  "action.failed",
  "action.interrupted",
  "work.completed",
  "resources.transferred",
  "inspection.completed",
  "command.rejected",
  "terrain.changed",
]);
export async function recordMemories(
  tx: Transaction,
  result: Transition,
  citizenId: string,
) {
  const state = result.state;
  for (const observation of result.observations.filter(
    (source) => source.citizenId === citizenId && significant.has(source.kind),
  )) {
    const [known] = await tx
      .select({ id: memoryMembers.sourceId })
      .from(memoryMembers)
      .where(
        and(
          eq(memoryMembers.runId, state.runId),
          eq(memoryMembers.citizenId, citizenId),
          eq(memoryMembers.sourceId, observation.id),
        ),
      )
      .limit(1);
    if (known) continue;
    const event = result.events.find(
      (item) => item.sequence === observation.eventSequence,
    )!;
    const ownJob = Object.values(event.patch.jobs ?? {}).find(
      (job) => job.actorId === citizenId,
    );
    const ownAction =
      "actorId" in result.receipt.action &&
      result.receipt.action.actorId === citizenId;
    const source: MemorySource = {
      id: observation.id,
      citizenId,
      sequence: observation.eventSequence,
      simTimeMs: observation.simTimeMs,
      kind: observation.kind,
      content: observation.content,
      actorId: event.actorId,
      participantIds: [
        ...new Set([
          ...(event.audienceIds ?? [citizenId]),
          ...(event.actorId ? [event.actorId] : []),
        ]),
      ],
      entityIds: observation.entityIds,
      ...(ownAction
        ? { action: result.receipt.action, receipt: result.receipt }
        : {}),
      ...(ownJob
        ? {
            result: {
              jobId: ownJob.id,
              kind: ownJob.kind,
              status: ownJob.status,
            },
          }
        : {}),
    };
    const key = episodeKey(source);
    const [session] = await tx
      .select({ memory: memories, lastTimeMs: memorySessions.lastTimeMs })
      .from(memorySessions)
      .innerJoin(memories, eq(memories.id, memorySessions.memoryId))
      .where(
        and(
          eq(memorySessions.runId, state.runId),
          eq(memorySessions.citizenId, citizenId),
          eq(memorySessions.key, key),
        ),
      )
      .limit(1);
    const previousSources = (session?.memory.payload.sources ??
      []) as MemorySource[];
    const canContinue = Boolean(
      session &&
      (key.startsWith("activity:") ||
        source.simTimeMs - session.lastTimeMs <=
          memoryPolicy.conversationGapMs) &&
      previousSources.length < memoryPolicy.maxSources &&
      session.memory.text.length + source.content.length <
        memoryPolicy.maxEpisodeCharacters,
    );
    const sources = canContinue ? [...previousSources, source] : [source];
    const logicalId = canContinue
      ? session!.memory.logicalId
      : `episode-${source.sequence}-${citizenId}`;
    const text = sources
      .map(
        (item) =>
          `[${item.simTimeMs}] ${item.content}${item.action ? ` Action: ${JSON.stringify(item.action)}` : ""}`,
      )
      .join("\n");
    const memory = await putMemory(tx, {
      runId: state.runId,
      citizenId,
      logicalId,
      kind: "episode",
      certainty: source.kind === "speech.delivered" ? "reported" : "observed",
      title:
        source.kind === "speech.delivered"
          ? "Received conversation"
          : source.kind,
      text,
      searchText: text,
      sourceIds: sources.map((item) => item.id),
      entityIds: [
        ...new Set(
          sources.flatMap((item) => [
            ...item.entityIds,
            ...item.participantIds,
          ]),
        ),
      ],
      eventStartMs: sources[0]!.simTimeMs,
      eventEndMs: source.simTimeMs,
      sourceCutoff: source.sequence,
      availableSequence: source.sequence,
      payload: { sources, sessionKey: key, raw: true },
    });
    await tx
      .insert(memoryMembers)
      .values({
        runId: state.runId,
        citizenId,
        sourceId: source.id,
        logicalId,
        sequence: source.sequence,
      });
    await tx
      .insert(memorySessions)
      .values({
        runId: state.runId,
        citizenId,
        key,
        memoryId: memory.id,
        lastTimeMs: source.simTimeMs,
      })
      .onConflictDoUpdate({
        target: [
          memorySessions.runId,
          memorySessions.citizenId,
          memorySessions.key,
        ],
        set: { memoryId: memory.id, lastTimeMs: source.simTimeMs },
      });
    if (session && !canContinue && key.startsWith("conversation:"))
      await tx
        .insert(memoryEdges)
        .values({
          runId: state.runId,
          citizenId,
          fromId: memory.id,
          toId: session.memory.id,
          relation: "continues",
        })
        .onConflictDoNothing();
    if (session && canContinue) {
      const stale = await tx
        .select({ id: memoryTasks.id })
        .from(memoryTasks)
        .innerJoin(backgroundTasks, eq(backgroundTasks.id, memoryTasks.id))
        .where(
          and(
            eq(memoryTasks.memoryId, session.memory.id),
            inArray(backgroundTasks.status, ["pending", "queued"]),
            isNull(memoryTasks.ownerId),
          ),
        );
      if (stale.length)
        await tx
          .update(backgroundTasks)
          .set({ status: "superseded" })
          .where(
            inArray(
              backgroundTasks.id,
              stale.map((item) => item.id),
            ),
          );
      await tx
        .update(memoryIndexes)
        .set({ status: "superseded" })
        .where(
          and(
            eq(memoryIndexes.memoryId, session.memory.id),
            eq(memoryIndexes.status, "pending"),
          ),
        );
    }
    await queueMemoryTask(tx, {
      runId: state.runId,
      citizenId,
      memoryId: memory.id,
      cutoff: source.sequence,
      operation: source.kind === "speech.delivered" ? "extract" : "embed",
    });
  }
  await tx
    .update(memoryStreams)
    .set({ processedSequence: state.sequence })
    .where(
      and(
        eq(memoryStreams.runId, state.runId),
        eq(memoryStreams.citizenId, citizenId),
      ),
    );
  const self = state.citizens[citizenId]!;
  const sleeping = self.actionId
    ? state.jobs[self.actionId]?.kind === "sleep"
    : false;
  if (
    sleeping &&
    result.events.some(
      (event) => event.kind === "action.started" && event.actorId === citizenId,
    )
  )
    await queueMemoryTask(tx, {
      runId: state.runId,
      citizenId,
      memoryId: null,
      cutoff: state.sequence,
      operation: "consolidate",
    });
}
