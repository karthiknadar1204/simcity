import type { Database } from "@repo/db";
import { contentHash, type PlaybackBundle } from "@repo/contracts";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import { checkpoints, events } from "@repo/db/tables";
import { WorldStore, StoreError } from "./world-store";
export class PlaybackStore {
  constructor(readonly db: Database) {}
  async bundle(
    runId: string,
    fromMs: number,
    toMs: number,
    upperSequence?: number,
  ): Promise<PlaybackBundle> {
    const worlds = new WorldStore(this.db),
      current = await worlds.current(runId),
      upper = upperSequence ?? current.state.sequence;
    if (
      !Number.isSafeInteger(upper) ||
      upper < 0 ||
      upper > current.state.sequence
    )
      throw new StoreError("Invalid recorded sequence.", 400);
    const endState =
      upper === current.state.sequence
        ? current.state
        : await worlds.atSequence(runId, upper);
    if (
      !Number.isSafeInteger(fromMs) ||
      !Number.isSafeInteger(toMs) ||
      fromMs > toMs ||
      toMs > endState.simTimeMs
    )
      throw new StoreError("Choose a time inside the recorded interval.", 400);
    const [[startEvent], [afterEnd]] = await Promise.all([
      this.db
        .select({ sequence: events.sequence })
        .from(events)
        .where(
          and(
            eq(events.runId, runId),
            lte(events.sequence, upper),
            lte(events.simTimeMs, fromMs),
          ),
        )
        .orderBy(desc(events.sequence))
        .limit(1),
      this.db
        .select({ time: events.simTimeMs })
        .from(events)
        .where(
          and(
            eq(events.runId, runId),
            lte(events.sequence, upper),
            gt(events.simTimeMs, toMs),
          ),
        )
        .orderBy(asc(events.sequence))
        .limit(1),
    ]);
    const [checkpoint] = await this.db
      .select()
      .from(checkpoints)
      .where(
        and(
          eq(checkpoints.runId, runId),
          lte(checkpoints.sequence, startEvent?.sequence ?? 0),
        ),
      )
      .orderBy(desc(checkpoints.sequence))
      .limit(1);
    if (!checkpoint || fromMs < checkpoint.simTimeMs)
      throw new StoreError("No checkpoint covers the recorded time.", 404);
    if ((await contentHash(checkpoint.state)) !== checkpoint.stateHash)
      throw new StoreError("Checkpoint hash mismatch.", 500);
    const rows = await this.db
      .select({ event: events.payload })
      .from(events)
      .where(
        and(
          eq(events.runId, runId),
          gt(events.sequence, checkpoint.sequence),
          lte(events.sequence, upper),
          lte(events.simTimeMs, afterEnd?.time ?? toMs),
        ),
      )
      .orderBy(asc(events.sequence))
      .limit(20001);
    if (rows.length > 20000)
      throw new StoreError(
        "Recorded interval is too large; choose a shorter excerpt.",
        400,
      );
    return {
      version: 1,
      runId,
      checkpoint: { state: checkpoint.state, stateHash: checkpoint.stateHash },
      events: rows.map((row) => row.event),
      fromMs,
      toMs,
      upperSequence: upper,
    };
  }
}
