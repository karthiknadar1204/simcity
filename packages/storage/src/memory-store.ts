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
  | { kind: "commitment"; commitment: CommitmentRecord };
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
    if (commitment) return { kind: "commitment", commitment };
    const [source] = await this.sources(runId, citizenId, asOf, [id]);
    return source ? { kind: "source", source } : null;
  }
  async commitments(
    runId: string,
    citizenId: string,
    asOf: number,
    limit = memoryPolicy.maxObligations + 1,
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
        sql`${commitmentVersions.deadlineMs} asc nulls last`,
        desc(commitmentVersions.availableSequence),
      )
      .limit(Math.min(100, limit));
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
      mode: vector ? "hybrid" : "text",
      pendingIndexes: pending[0]?.count ?? 0,
      sourceIds: [
        ...new Set(candidates.flatMap((item) => item.memory.sourceIds)),
      ],
      fallback: vector
        ? null
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
