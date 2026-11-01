import { and, eq, isNull, sql } from "drizzle-orm";
import {
  commands,
  commitmentVersions,
  events,
  observations,
} from "@repo/db/tables";
import { contentHash, type MemorySource } from "@repo/contracts";
import type { Transaction } from "./thinking-records";

export async function recordFulfillment(
  tx: Transaction,
  runId: string,
  citizenId: string,
  source: MemorySource,
  availableSequence: number,
) {
  if (
    source.kind !== "resources.transferred" ||
    source.action?.kind !== "transfer" ||
    source.receipt?.status !== "accepted"
  )
    return [] as string[];
  const action = source.action;
  const matches = await tx
    .select()
    .from(commitmentVersions)
    .where(
      and(
        eq(commitmentVersions.runId, runId),
        eq(commitmentVersions.citizenId, citizenId),
        eq(commitmentVersions.status, "accepted"),
        isNull(commitmentVersions.supersededSequence),
        eq(commitmentVersions.debtorId, action.actorId),
        eq(commitmentVersions.creditorId, action.targetId),
        eq(commitmentVersions.resource, action.resource),
        eq(commitmentVersions.amount, action.amount),
        sql`${commitmentVersions.effectiveSequence} < ${source.sequence}`,
      ),
    )
    .limit(2);
  // An unlabeled transfer cannot choose between several otherwise matching obligations.
  if (matches.length !== 1) return [] as string[];
  const previous = matches[0]!;
  const [used] = await tx
    .select({ id: commitmentVersions.id })
    .from(commitmentVersions)
    .where(
      and(
        eq(commitmentVersions.runId, runId),
        eq(commitmentVersions.citizenId, citizenId),
        eq(commitmentVersions.status, "fulfilled"),
        sql`${commitmentVersions.sourceIds} ? ${source.id}`,
      ),
    )
    .limit(1);
  if (used) return [] as string[];
  const version = previous.version + 1;
  await tx
    .update(commitmentVersions)
    .set({ supersededSequence: availableSequence })
    .where(eq(commitmentVersions.id, previous.id));
  await tx
    .insert(commitmentVersions)
    .values({
      ...previous,
      id: `cv-${await contentHash({ logicalId: previous.logicalId, version })}`,
      version,
      status: "fulfilled",
      sourceIds: [...new Set([...previous.sourceIds, source.id])],
      effectiveSequence: source.sequence,
      availableSequence,
      supersededSequence: null,
    });
  return [previous.logicalId];
}

export async function reconcileFulfillments(
  tx: Transaction,
  runId: string,
  citizenId: string,
  availableSequence: number,
) {
  const rows = await tx
    .select({
      observation: observations.payload,
      receipt: commands.receipt,
      command: commands.request,
    })
    .from(observations)
    .innerJoin(
      events,
      and(
        eq(events.runId, observations.runId),
        eq(events.sequence, observations.eventSequence),
      ),
    )
    .innerJoin(
      commands,
      and(
        eq(commands.runId, events.runId),
        sql`${commands.id} = ${events.payload}->>'causeId'`,
      ),
    )
    .where(
      and(
        eq(observations.runId, runId),
        eq(observations.citizenId, citizenId),
        sql`${observations.payload}->>'kind' = 'resources.transferred'`,
        sql`${observations.eventSequence} <= ${availableSequence}`,
        sql`exists (select 1 from sim_commitment_versions cv where cv.run_id = ${runId} and cv.citizen_id = ${citizenId} and cv.status = 'accepted' and cv.superseded_sequence is null and cv.effective_sequence < ${observations.eventSequence} and cv.debtor_id = ${commands.request}->'action'->>'actorId' and cv.creditor_id = ${commands.request}->'action'->>'targetId' and cv.resource = ${commands.request}->'action'->>'resource' and cv.amount = (${commands.request}->'action'->>'amount')::int)`,
      ),
    )
    .orderBy(observations.eventSequence)
    .limit(100);
  let count = 0;
  for (const row of rows) {
    if (row.command.action.kind !== "transfer") continue;
    const observation = row.observation;
    count += (
      await recordFulfillment(
        tx,
        runId,
        citizenId,
        {
          id: observation.id,
          citizenId,
          sequence: observation.eventSequence,
          simTimeMs: observation.simTimeMs,
          kind: observation.kind,
          content: observation.content,
          actorId: row.command.action.actorId,
          participantIds: [
            row.command.action.actorId,
            row.command.action.targetId,
          ],
          entityIds: observation.entityIds,
          action: row.command.action,
          receipt: row.receipt,
        },
        availableSequence,
      )
    ).length;
  }
  return count;
}
