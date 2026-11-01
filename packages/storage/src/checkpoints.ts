import type { Database } from "@repo/db";
import type { WorldState } from "@repo/contracts";
import { backgroundTasks, checkpoints, outbox } from "@repo/db/tables";

export async function saveCheckpoint(
  writer: Pick<Database, "insert">,
  state: WorldState,
  stateHash: string,
) {
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
}
