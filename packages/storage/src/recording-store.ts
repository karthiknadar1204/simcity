import type { Database } from "@repo/db";
import { and, asc, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import {
  backgroundTasks,
  checkpoints,
  events,
  modelRounds,
  outbox,
  recordingChunks,
  thinkingTurns,
  contextCompilations,
  memoryTasks,
  memoryCalls,
} from "@repo/db/tables";
import {
  contentHash,
  type PlaybackBundle,
  type RecordingDescriptor,
  type RecordingPayload,
  type WorldState,
} from "@repo/contracts";
import { replay } from "@repo/engine";
import type { ArchiveStore } from "./r2";
import type { Transaction } from "./thinking-records";
export async function queueRecording(
  writer: Pick<Database, "insert">,
  state: WorldState,
  fromSequence: number,
  startMs: number,
) {
  const id = `${state.runId}-recording-${fromSequence}-${state.sequence}`;
  const payload: RecordingPayload = {
    runId: state.runId,
    fromSequence,
    toSequence: state.sequence,
  };
  await writer
    .insert(backgroundTasks)
    .values({
      id,
      runId: state.runId,
      kind: "archive.interval",
      payload,
      status: "pending",
    })
    .onConflictDoNothing();
  await writer
    .insert(recordingChunks)
    .values({
      id,
      runId: state.runId,
      fromSequence,
      toSequence: state.sequence,
      startMs,
      endMs: state.simTimeMs,
    })
    .onConflictDoNothing();
  await writer.insert(outbox).values({ taskId: id }).onConflictDoNothing();
  return id;
}
export class RecordingStore {
  constructor(readonly db: Database) {}
  async list(runId: string) {
    return this.db
      .select({
        chunk: recordingChunks,
        status: backgroundTasks.status,
        error: backgroundTasks.error,
      })
      .from(recordingChunks)
      .innerJoin(backgroundTasks, eq(backgroundTasks.id, recordingChunks.id))
      .where(eq(recordingChunks.runId, runId))
      .orderBy(desc(recordingChunks.toSequence))
      .limit(100);
  }
  async queueExisting(runId: string, sequence: number) {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(checkpoints)
        .where(
          and(
            eq(checkpoints.runId, runId),
            lte(checkpoints.sequence, sequence),
          ),
        )
        .orderBy(desc(checkpoints.sequence))
        .limit(2);
      if (!rows[0]) throw new Error("Checkpoint not found.");
      return queueRecording(
        tx,
        rows[0].state,
        rows[1]?.sequence ?? rows[0].sequence,
        rows[1]?.simTimeMs ?? rows[0].simTimeMs,
      );
    });
  }
  async source(payload: RecordingPayload) {
    const [start] = await this.db
      .select()
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.runId, payload.runId),
          eq(checkpoints.sequence, payload.fromSequence),
        ),
      )
      .limit(1);
    const [end] = await this.db
      .select()
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.runId, payload.runId),
          eq(checkpoints.sequence, payload.toSequence),
        ),
      )
      .limit(1);
    if (
      !start ||
      !end ||
      (await contentHash(start.state)) !== start.stateHash ||
      (await contentHash(end.state)) !== end.stateHash
    )
      throw new Error("Recording checkpoint missing or invalid.");
    const rows = await this.db
      .select({ event: events.payload })
      .from(events)
      .where(
        and(
          eq(events.runId, payload.runId),
          gt(events.sequence, payload.fromSequence),
          lte(events.sequence, payload.toSequence),
        ),
      )
      .orderBy(asc(events.sequence))
      .limit(20001);
    if (
      rows.length > 20000 ||
      rows.length !== payload.toSequence - payload.fromSequence
    )
      throw new Error("Recording interval is incomplete or exceeds its limit.");
    const recorded = rows.map((row) => row.event);
    if ((await contentHash(replay(start.state, recorded))) !== end.stateHash)
      throw new Error("Recording replay hash mismatch.");
    const turns = await this.db
      .select({ turn: thinkingTurns })
      .from(thinkingTurns)
      .innerJoin(backgroundTasks, eq(backgroundTasks.id, thinkingTurns.id))
      .where(
        and(
          eq(backgroundTasks.runId, payload.runId),
          gt(thinkingTurns.finishedSequence, payload.fromSequence),
          lte(thinkingTurns.finishedSequence, payload.toSequence),
        ),
      )
      .orderBy(asc(thinkingTurns.finishedSequence))
      .limit(251);
    if (turns.length > 250)
      throw new Error(
        "Recording trace window is too large; retain hot data and subdivide.",
      );
    const ids = turns.map((row) => row.turn.id);
    const rounds = ids.length
      ? await this.db
          .select()
          .from(modelRounds)
          .where(inArray(modelRounds.taskId, ids))
          .orderBy(asc(modelRounds.taskId), asc(modelRounds.round))
      : [];
    const memoryIds = [
      ...new Set(
        recorded
          .filter(
            (event) =>
              event.kind === "memory.published" ||
              event.kind === "memory.indexed",
          )
          .map((event) => event.causeId),
      ),
    ];
    if (memoryIds.length > 500)
      throw new Error(
        "Recording memory trace interval exceeds its limit; hot data retained.",
      );
    const [publishedTasks, publishedCalls, audits] = await Promise.all([
      memoryIds.length
        ? this.db
            .select()
            .from(memoryTasks)
            .where(inArray(memoryTasks.id, memoryIds))
        : [],
      memoryIds.length
        ? this.db
            .select()
            .from(memoryCalls)
            .where(inArray(memoryCalls.taskId, memoryIds))
        : [],
      ids.length
        ? this.db
            .select()
            .from(contextCompilations)
            .where(inArray(contextCompilations.taskId, ids))
        : [],
    ]);
    const bundle: PlaybackBundle = {
      version: 1,
      runId: payload.runId,
      checkpoint: { state: start.state, stateHash: start.stateHash },
      events: recorded,
      fromMs: start.simTimeMs,
      toMs: end.simTimeMs,
      upperSequence: end.sequence,
    };
    return {
      version: 1,
      bundle,
      endStateHash: end.stateHash,
      retrievalAudits: audits,
      memoryTraces: publishedTasks.map((task) => ({
        ...task,
        calls: publishedCalls.filter((call) => call.taskId === task.id),
      })),
      traces: turns.map(({ turn }) => ({
        ...turn,
        rounds: rounds.filter((round) => round.taskId === turn.id),
      })),
    };
  }
  async publish(
    taskId: string,
    payload: RecordingPayload,
    archive: ArchiveStore,
  ) {
    const [existing] = await this.db
      .select()
      .from(recordingChunks)
      .where(
        and(
          eq(recordingChunks.id, taskId),
          eq(recordingChunks.runId, payload.runId),
          eq(recordingChunks.fromSequence, payload.fromSequence),
          eq(recordingChunks.toSequence, payload.toSequence),
        ),
      )
      .limit(1);
    if (!existing)
      throw new Error("Recording task does not match its interval.");
    if (existing.manifest) return existing.manifest;
    const source = await this.source(payload),
      body = JSON.stringify(source),
      digest = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    if (new TextEncoder().encode(body).length > 16 * 1024 * 1024)
      throw new Error(
        "Recording exceeds 16 MiB; retain hot data and subdivide.",
      );
    const uploaded = await archive.put(
      `runs/${payload.runId}/recordings/${payload.fromSequence}-${payload.toSequence}-${digest}.json`,
      body,
    );
    const manifest: RecordingDescriptor = {
      version: 1,
      runId: payload.runId,
      fromSequence: payload.fromSequence,
      toSequence: payload.toSequence,
      startMs: source.bundle.fromMs,
      endMs: source.bundle.toMs,
      ...uploaded,
      traceCount: source.traces.length + source.memoryTraces.length,
    };
    await this.db.transaction(async (tx: Transaction) => {
      await tx
        .update(recordingChunks)
        .set({ manifest })
        .where(
          and(
            eq(recordingChunks.id, taskId),
            sql`${recordingChunks.manifest} is null`,
          ),
        );
      await tx
        .update(backgroundTasks)
        .set({ status: "completed", error: null })
        .where(eq(backgroundTasks.id, taskId));
    });
    const [published] = await this.db
      .select()
      .from(recordingChunks)
      .where(eq(recordingChunks.id, taskId))
      .limit(1);
    return published!.manifest!;
  }
  async read(runId: string, id: string, archive: ArchiveStore) {
    const [row] = await this.db
      .select()
      .from(recordingChunks)
      .where(and(eq(recordingChunks.runId, runId), eq(recordingChunks.id, id)))
      .limit(1);
    if (!row?.manifest) throw new Error("Published recording not found.");
    const m = row.manifest,
      body = await archive.read(m.key, m.checksum, m.bytes);
    return JSON.parse(new TextDecoder().decode(body)) as Awaited<
      ReturnType<RecordingStore["source"]>
    >;
  }
}
