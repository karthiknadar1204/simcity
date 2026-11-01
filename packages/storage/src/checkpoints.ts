import type { Database } from "@repo/db";
import type { WorldState } from "@repo/contracts";
import { backgroundTasks, checkpoints, outbox } from "@repo/db/tables";
import { and, desc, eq, lt } from "drizzle-orm";
import { queueRecording } from "./recording-store";

export async function saveCheckpoint(
  writer: Pick<Database, "insert" | "select">,
  state: WorldState,
  stateHash: string,
) {
  const [previous] = await writer
    .select()
    .from(checkpoints)
    .where(
      and(
        eq(checkpoints.runId, state.runId),
        lt(checkpoints.sequence, state.sequence),
      ),
    )
    .orderBy(desc(checkpoints.sequence))
    .limit(1);
  await writer
    .insert(checkpoints)
    .values({
      runId: state.runId,
      sequence: state.sequence,
      simTimeMs: state.simTimeMs,
      state,
      stateHash,
    })
    .onConflictDoNothing();
  const id = `${state.runId}-checkpoint-${state.sequence}`;
  await writer
    .insert(backgroundTasks)
    .values({
      id,
      runId: state.runId,
      kind: "archive.checkpoint",
      payload: { runId: state.runId, sequence: state.sequence },
      status: "pending",
    })
    .onConflictDoNothing();
  await writer.insert(outbox).values({ taskId: id }).onConflictDoNothing();
  await queueRecording(
    writer,
    state,
    previous?.sequence ?? state.sequence,
    previous?.simTimeMs ?? state.simTimeMs,
  );
}
