import type { Database } from "@repo/db";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
  cosineDistance,
} from "drizzle-orm";
import {
  memories,
  memoryIndexes,
  memoryEntities,
  memoryEdges,
  commitmentVersions,
  observations,
  events,
  commands,
  runs,
  memoryStreams,
  contextCompilations,
  queryEmbeddings,
  modelRounds,
  thinkingTurns,
  memoryTasks,
  backgroundTasks,
} from "@repo/db/tables";
import {
  memoryPolicy,
  type CommitmentRecord,
  type MemoryRecord,
  type MemorySource,
  type MemoryRetrieval,
  type RetrievedMemory,
} from "@repo/contracts";
import type { RetrievalAudit } from "@repo/db/tables";
import { currentAt } from "@repo/memory";

export type MemoryRead =
  | { kind: "memory"; memory: MemoryRecord; current: boolean }
  | { kind: "source"; source: MemorySource }
  | { kind: "commitment"; commitment: CommitmentRecord; current: boolean };
const scope = (runId: string, citizenId: string, asOf: number) =>
  and(
    eq(memories.runId, runId),
    eq(memories.citizenId, citizenId),
    lte(memories.availableSequence, asOf),
    or(
      isNull(memories.supersededSequence),
      gt(memories.supersededSequence, asOf),
    ),
  );

export class MemoryStore {
  constructor(readonly db: Database) {}
  async inspect(runId: string, citizenId: string, asOf: number, query = "") {
    const retrieval = query
      ? await this.search(runId, citizenId, asOf, query)
      : null;
    const records = retrieval
      ? retrieval.candidates.map((item) => item.memory).slice(0, 40)
      : await this.list(runId, citizenId, asOf);
    const ids = records.map((item) => item.id);
    const indexes = ids.length
      ? await this.db
          .select()
          .from(memoryIndexes)
          .where(inArray(memoryIndexes.memoryId, ids))
      : [];
    const [commitments, audits] = await Promise.all([
      this.commitments(runId, citizenId, asOf, 100),
      this.db
        .select()
        .from(contextCompilations)
        .where(
          and(
            eq(contextCompilations.runId, runId),
            eq(contextCompilations.citizenId, citizenId),
            lte(contextCompilations.boundary, asOf),
          ),
        )
        .orderBy(
          desc(contextCompilations.boundary),
          desc(contextCompilations.id),
        )
        .limit(8),
    ]);
    return {
      records: records.map((memory) => {
        const index = indexes.find((item) => item.memoryId === memory.id);
        return {
          ...memory,
          indexing:
            index?.availableSequence !== null &&
            index?.availableSequence !== undefined &&
            index.availableSequence <= asOf
              ? index.status
              : "pending",
        };
      }),
      commitments,
      audits,
      retrieval,
    };
  }
  async stream(runId: string, citizenId: string) {
    const [row] = await this.db
      .select()
      .from(memoryStreams)
      .where(
        and(
          eq(memoryStreams.runId, runId),
          eq(memoryStreams.citizenId, citizenId),
        ),
      )
      .limit(1);
    return row ?? null;
  }
  async list(
    runId: string,
    citizenId: string,
    asOf: number,
    limit = 40,
  ): Promise<MemoryRecord[]> {
    return this.db
      .select()
      .from(memories)
      .where(scope(runId, citizenId, asOf))
      .orderBy(desc(memories.availableSequence), desc(memories.id))
      .limit(Math.min(100, Math.max(1, limit)));
  }
  async consolidationBatch(
    runId: string,
    citizenId: string,
    asOf: number,
    after: number,
  ) {
    return this.db
      .select()
      .from(memories)
      .where(
        and(
          scope(runId, citizenId, asOf),
          eq(memories.kind, "episode"),
          sql`${memories.payload}->>'raw' = 'true'`,
          gt(memories.sourceCutoff, after),
        ),
      )
      .orderBy(asc(memories.sourceCutoff))
      .limit(12);
  }
  async logicalHead(
    runId: string,
    citizenId: string,
    asOf: number,
    logicalId: string,
  ) {
    const [record] = await this.db
      .select()
      .from(memories)
      .where(
        and(scope(runId, citizenId, asOf), eq(memories.logicalId, logicalId)),
      )
      .orderBy(desc(memories.version))
      .limit(1);
    return record ?? null;
  }
  async pendingSources(runId: string, citizenId: string, asOf: number) {
    const pending = await this.db
      .select({ memory: memories })
      .from(memoryTasks)
      .innerJoin(backgroundTasks, eq(backgroundTasks.id, memoryTasks.id))
      .innerJoin(memories, eq(memories.id, memoryTasks.memoryId))
      .where(
        and(
          scope(runId, citizenId, asOf),
          eq(memoryTasks.operation, "extract"),
          inArray(backgroundTasks.status, [
            "pending",
            "queued",
            "running",
            "failed",
          ]),
        ),
      )
      .orderBy(asc(memoryTasks.cutoff))
      .limit(4);
    const ids = [
      ...new Set(pending.flatMap((item) => item.memory.sourceIds)),
    ].slice(0, 24);
    return {
      episodes: pending.map((item) => item.memory.id),
      sources: ids.length
        ? await this.sources(runId, citizenId, asOf, ids)
        : [],
    };
  }
  async sources(
    runId: string,
    citizenId: string,
    asOf: number,
    ids?: string[],
    limit = 24,
  ): Promise<MemorySource[]> {
    const selected = ids ? [...new Set(ids)].slice(0, 100) : undefined;
    const result: MemorySource[] = [];
    if (selected?.some((id) => /^seed-\d+$/.test(id))) {
      const [run] = await this.db
        .select({ state: runs.state })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1);
      for (const id of selected) {
        const match = /^seed-(\d+)$/.exec(id),
          content = match
            ? run?.state.citizens[citizenId]?.initialMemories[Number(match[1])]
            : undefined;
        if (content)
          result.push({
            id,
            citizenId,
            sequence: 0,
            simTimeMs: 0,
            kind: "seed",
            content,
            actorId: citizenId,
            participantIds: [citizenId],
            entityIds: [],
          });
      }
    }
    const sequences = selected?.flatMap((id) =>
      /^\d+-/.test(id) ? [Number(id.split("-")[0])] : [],
    );
    if (selected && !sequences!.length) return result;
    const rows = await this.db
      .select({
        observation: observations.payload,
        event: events.payload,
        command: commands.request,
        receipt: commands.receipt,
      })
      .from(observations)
      .innerJoin(
        events,
        and(
          eq(events.runId, observations.runId),
          eq(events.sequence, observations.eventSequence),
        ),
      )
      .leftJoin(
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
          lte(observations.eventSequence, asOf),
          sequences
            ? inArray(observations.eventSequence, sequences)
            : sql`${observations.payload}->>'kind' not in ('command.accepted', 'plan.updated')`,
        ),
      )
      .orderBy(desc(observations.eventSequence))
      .limit(Math.min(100, selected ? selected.length : limit));
    for (const row of rows) {
      const observation = row.observation;
      if (selected && !selected.includes(observation.id)) continue;
      const action = row.command?.action;
      const own =
        action &&
        "actorId" in action &&
        (action.actorId === citizenId ||
          (action.kind === "transfer" && action.targetId === citizenId));
      const job = Object.values(row.event.patch.jobs ?? {}).find(
        (item) => item.actorId === citizenId,
      );
      result.push({
        id: observation.id,
        citizenId,
        sequence: observation.eventSequence,
        simTimeMs: observation.simTimeMs,
        kind: observation.kind,
        content: observation.content,
        actorId: row.event.actorId,
        ...(["speech.delivered", "alert.delivered"].includes(
          observation.kind,
        ) &&
        action &&
        "text" in action
          ? { utterance: action.text }
          : {}),
        participantIds: [
          ...new Set([
            ...(row.event.audienceIds ?? [citizenId]),
            ...(row.event.actorId ? [row.event.actorId] : []),
          ]),
        ],
        entityIds: observation.entityIds,
        ...(own && row.receipt ? { action, receipt: row.receipt } : {}),
        ...(job
          ? { result: { jobId: job.id, kind: job.kind, status: job.status } }
          : {}),
      });
    }
    return result;
  }
  async read(
    runId: string,
    citizenId: string,
    asOf: number,
    id: string,
  ): Promise<MemoryRead | null> {
    const [memory] = await this.db
      .select()
      .from(memories)
      .where(
        and(
          eq(memories.runId, runId),
          eq(memories.citizenId, citizenId),
          eq(memories.id, id),
          lte(memories.availableSequence, asOf),
        ),
      )
      .limit(1);
    if (memory)
      return { kind: "memory", memory, current: currentAt(memory, asOf) };
    const [commitment] = await this.db
      .select()
      .from(commitmentVersions)
      .where(
        and(
          eq(commitmentVersions.runId, runId),
          eq(commitmentVersions.citizenId, citizenId),
          eq(commitmentVersions.id, id),
          lte(commitmentVersions.availableSequence, asOf),
        ),
      )
      .limit(1);
    if (commitment)
      return {
        kind: "commitment",
        commitment,
        current: currentAt(commitment, asOf),
      };
    const [source] = await this.sources(runId, citizenId, asOf, [id]);
    return source ? { kind: "source", source } : null;
  }
  async commitments(
    runId: string,
    citizenId: string,
    asOf: number,
    limit = memoryPolicy.maxObligations + 1,
    offset = 0,
  ): Promise<CommitmentRecord[]> {
    return this.db
      .select()
      .from(commitmentVersions)
      .where(
        and(
          eq(commitmentVersions.runId, runId),
          eq(commitmentVersions.citizenId, citizenId),
          lte(commitmentVersions.availableSequence, asOf),
          or(
            isNull(commitmentVersions.supersededSequence),
            gt(commitmentVersions.supersededSequence, asOf),
          ),
        ),
      )
      .orderBy(
        sql`case when ${commitmentVersions.status} = 'accepted' then 0 else 1 end`,
        sql`${commitmentVersions.deadlineMs} asc nulls last`,
        desc(commitmentVersions.availableSequence),
      )
      .limit(Math.min(100, Math.max(1, limit)))
      .offset(Math.max(0, offset));
  }
  async recentToolRejections(runId: string, citizenId: string, asOf: number) {
    return this.db
      .select({
        tool: sql`${modelRounds.answer}->'call'`,
        outcome: modelRounds.outcome,
        recordedAtSequence: thinkingTurns.finishedSequence,
      })
      .from(modelRounds)
      .innerJoin(thinkingTurns, eq(thinkingTurns.id, modelRounds.taskId))
      .innerJoin(backgroundTasks, eq(backgroundTasks.id, thinkingTurns.id))
      .where(
        and(
          eq(backgroundTasks.runId, runId),
          eq(thinkingTurns.citizenId, citizenId),
          lte(thinkingTurns.finishedSequence, asOf),
          sql`${modelRounds.outcome}->>'status' = 'rejected'`,
        ),
      )
      .orderBy(
        desc(thinkingTurns.finishedSequence),
        desc(backgroundTasks.createdAt),
        desc(modelRounds.round),
      )
      .limit(1);
  }

  async recentActions(runId: string, citizenId: string, asOf: number) {
    return this.db
      .select({ command: commands.request, receipt: commands.receipt })
      .from(commands)
      .where(
        and(
          eq(commands.runId, runId),
          sql`${commands.request}->'action'->>'actorId' = ${citizenId}`,
          sql`(${commands.receipt}->>'eventSequence')::bigint <= ${asOf}`,
          sql`${commands.request}->'action'->>'kind' not in ('plan', 'inspect')`,
        ),
      )
      .orderBy(sql`(${commands.receipt}->>'eventSequence')::bigint desc`)
      .limit(memoryPolicy.maxRecentActions);
  }
  async commitmentsByLogicalIds(
    runId: string,
    citizenId: string,
    asOf: number,
    ids: string[],
  ) {
    if (!ids.length) return [] as CommitmentRecord[];
    return this.db
      .select()
      .from(commitmentVersions)
      .where(
        and(
          eq(commitmentVersions.runId, runId),
          eq(commitmentVersions.citizenId, citizenId),
          inArray(commitmentVersions.logicalId, [...new Set(ids)].slice(0, 12)),
          lte(commitmentVersions.availableSequence, asOf),
          or(
            isNull(commitmentVersions.supersededSequence),
            gt(commitmentVersions.supersededSequence, asOf),
          ),
        ),
      )
      .limit(12);
  }
  async obligationCounts(
    runId: string,
    citizenId: string,
    asOf: number,
    simTimeMs: number,
  ) {
    const [counts] = await this.db
      .select({
        accepted: sql<number>`count(*) filter (where ${commitmentVersions.status} = 'accepted')::int`,
        due: sql<number>`count(*) filter (where ${commitmentVersions.status} = 'accepted' and ${commitmentVersions.deadlineMs} <= ${simTimeMs})::int`,
      })
      .from(commitmentVersions)
      .where(
        and(
          eq(commitmentVersions.runId, runId),
          eq(commitmentVersions.citizenId, citizenId),
          lte(commitmentVersions.availableSequence, asOf),
          or(
            isNull(commitmentVersions.supersededSequence),
            gt(commitmentVersions.supersededSequence, asOf),
          ),
        ),
      );
    return counts ?? { accepted: 0, due: 0 };
  }
  async search(
    runId: string,
    citizenId: string,
    asOf: number,
    query: string,
    vector?: number[],
    entities: string[] = [],
  ): Promise<MemoryRetrieval> {
    if (
      vector &&
      (vector.length !== memoryPolicy.dimensions ||
        vector.some((value) => !Number.isFinite(value)))
    )
      throw new Error("Embedding dimensions or values are invalid.");
    const rank = sql<number>`ts_rank_cd(to_tsvector('english', ${memories.searchText}), websearch_to_tsquery('english', ${query.slice(0, 1000)}))`;
    const [lexical, recent, pending] = await Promise.all([
      query.trim()
        ? this.db
            .select({ memory: memories, rank })
            .from(memories)
            .where(
              and(
                scope(runId, citizenId, asOf),
                sql`to_tsvector('english', ${memories.searchText}) @@ websearch_to_tsquery('english', ${query.slice(0, 1000)})`,
              ),
            )
            .orderBy(desc(rank), desc(memories.eventEndMs))
            .limit(30)
        : Promise.resolve([]),
      this.list(runId, citizenId, asOf, 8),
      this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(memoryIndexes)
        .innerJoin(memories, eq(memories.id, memoryIndexes.memoryId))
        .where(
          and(
            scope(runId, citizenId, asOf),
            eq(memoryIndexes.status, "pending"),
          ),
        ),
    ]);
    const ranked = new Map<string, RetrievedMemory>();
    let usedVector = false;
    const add = (items: MemoryRecord[], channel: string, weight = 1) =>
      items.forEach((memory, index) => {
        const prior = ranked.get(memory.id) ?? {
          memory,
          score: 0,
          channels: [],
        };
        prior.score += weight / (60 + index + 1);
        if (!prior.channels.includes(channel)) prior.channels.push(channel);
        ranked.set(memory.id, prior);
      });
    add(
      lexical.map((item) => item.memory),
      "text",
    );
    add(recent, "recent", query.trim() ? 0.15 : 1);
    if (vector) {
      const distance = cosineDistance(memoryIndexes.embedding, vector);
      const semantic = await this.db
        .select({ memory: memories })
        .from(memories)
        .innerJoin(memoryIndexes, eq(memoryIndexes.memoryId, memories.id))
        .where(
          and(
            scope(runId, citizenId, asOf),
            eq(memoryIndexes.status, "ready"),
            eq(memoryIndexes.model, memoryPolicy.embeddingModel),
            eq(memoryIndexes.dimensions, memoryPolicy.dimensions),
            eq(memoryIndexes.textHash, memories.textHash),
            lte(memoryIndexes.availableSequence, asOf),
          ),
        )
        .orderBy(asc(distance))
        .limit(20);
      add(
        semantic.map((item) => item.memory),
        "vector",
      );
      usedVector = semantic.length > 0;
    }
    if (entities.length) {
      const entityMatches = await this.db
        .select({ memory: memories })
        .from(memoryEntities)
        .innerJoin(memories, eq(memories.id, memoryEntities.memoryId))
        .where(
          and(
            scope(runId, citizenId, asOf),
            eq(memoryEntities.runId, runId),
            eq(memoryEntities.citizenId, citizenId),
            inArray(memoryEntities.entityId, entities.slice(0, 12)),
          ),
        )
        .orderBy(desc(memories.eventEndMs))
        .limit(memoryPolicy.maxLinks);
      add(
        [
          ...new Map(
            entityMatches.map((item) => [item.memory.id, item.memory]),
          ).values(),
        ],
        "entity",
        0.4,
      );
    }
    const seedIds = [...ranked.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((item) => item.memory.id);
    if (seedIds.length) {
      const links = await this.db
        .select({ fromId: memoryEdges.fromId, toId: memoryEdges.toId })
        .from(memoryEdges)
        .where(
          and(
            eq(memoryEdges.runId, runId),
            eq(memoryEdges.citizenId, citizenId),
            or(
              inArray(memoryEdges.fromId, seedIds),
              inArray(memoryEdges.toId, seedIds),
            ),
            sql`exists (select 1 from sim_memories mf where mf.id = ${memoryEdges.fromId} and mf.run_id = ${runId} and mf.citizen_id = ${citizenId} and mf.available_sequence <= ${asOf})`,
            sql`exists (select 1 from sim_memories mt where mt.id = ${memoryEdges.toId} and mt.run_id = ${runId} and mt.citizen_id = ${citizenId} and mt.available_sequence <= ${asOf})`,
          ),
        )
        .limit(memoryPolicy.maxLinks);
      const linkedIds = [
        ...new Set(links.flatMap((item) => [item.fromId, item.toId])),
      ];
      if (linkedIds.length)
        add(
          await this.db
            .select()
            .from(memories)
            .where(
              and(
                scope(runId, citizenId, asOf),
                inArray(memories.id, linkedIds),
              ),
            )
            .limit(memoryPolicy.maxLinks),
          "link",
          0.3,
        );
    }
    const candidates = [...ranked.values()]
      .sort(
        (a, b) =>
          b.score - a.score || b.memory.eventEndMs - a.memory.eventEndMs,
      )
      .slice(0, memoryPolicy.maxCandidates);
    return {
      query,
      asOf,
      candidates,
      mode: usedVector ? "hybrid" : "text",
      pendingIndexes: pending[0]?.count ?? 0,
      sourceIds: [
        ...new Set(candidates.flatMap((item) => item.memory.sourceIds)),
      ],
      fallback: usedVector
        ? null
        : vector
          ? "No compatible vector index at this boundary; scoped text fallback was used."
          : "No query embedding; scoped text, entity, link and recent retrieval remain available.",
    };
  }
  async saveAudit(
    id: string,
    taskId: string,
    runId: string,
    citizenId: string,
    boundary: number,
    audit: RetrievalAudit,
  ) {
    await this.db
      .insert(contextCompilations)
      .values({ id, taskId, runId, citizenId, boundary, audit })
      .onConflictDoNothing();
  }
  async cachedQuery(runId: string, citizenId: string, textHash: string) {
    const [row] = await this.db
      .select()
      .from(queryEmbeddings)
      .where(
        and(
          eq(queryEmbeddings.runId, runId),
          eq(queryEmbeddings.citizenId, citizenId),
          eq(queryEmbeddings.textHash, textHash),
          eq(queryEmbeddings.model, memoryPolicy.embeddingModel),
          eq(queryEmbeddings.dimensions, memoryPolicy.dimensions),
        ),
      )
      .limit(1);
    return row?.embedding;
  }
  async cacheQuery(
    runId: string,
    citizenId: string,
    textHash: string,
    embedding: number[],
  ) {
    if (
      embedding.length !== memoryPolicy.dimensions ||
      embedding.some((value) => !Number.isFinite(value))
    )
      throw new Error("Invalid embedding.");
    await this.db
      .insert(queryEmbeddings)
      .values({
        runId,
        citizenId,
        textHash,
        model: memoryPolicy.embeddingModel,
        dimensions: memoryPolicy.dimensions,
        embedding,
      })
      .onConflictDoNothing();
  }
}
