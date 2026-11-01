import {
  memoryPolicy,
  type CommitmentRecord,
  type MemoryRetrieval,
  type MemorySource,
  type WorldState,
  type AgentGuard,
  type ActionJob,
} from "@repo/contracts";
import { ThinkingError, type MemoryStore } from "@repo/storage";
import type { RetrievalAudit } from "@repo/db/tables";
import type { MemoryQueries } from "./queries";
import { diverseMemories } from "@repo/memory";
import { buildContext } from "../context";
import { countInput } from "../openai";
import { citizenInstructions } from "../prompt";
export interface CompilationInput {
  base: Record<string, unknown>;
  retrieval: MemoryRetrieval;
  commitments: CommitmentRecord[];
  counts: { accepted: number; due: number };
  pending: { episodes: string[]; sources: MemorySource[] };
  evidence: MemorySource[];
  recentActions: unknown[];
  relatedCommitments: CommitmentRecord[];
}
export interface CompiledContext extends Record<string, unknown> {
  obligations: {
    current: CommitmentRecord[];
    acceptedCount: number;
    dueCount: number;
    omittedCount: number;
  };
  memories: {
    variant: string;
    retrieved: { id: string; text: string; sourceIds: string[] }[];
    evidence: { id: string; content: string }[];
    initial: unknown[];
    recent: unknown[];
    pending: {
      episodes: string[];
      sources: unknown[];
      windowLimited: boolean;
      omittedSources: number;
    };
  };
}
export function jobView(job: ActionJob | null | undefined) {
  if (!job) return null;
  const common = {
    id: job.id,
    commandId: job.commandId,
    kind: job.kind,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    reason: job.reason ?? null,
  };
  if (job.kind === "move")
    return {
      ...common,
      destination: job.path[job.path.length - 1],
      nextTile: job.path[job.stepIndex + 1] ?? null,
      stepIndex: job.stepIndex,
      remainingSteps: Math.max(0, job.path.length - job.stepIndex - 1),
    };
  if (job.kind === "work")
    return {
      ...common,
      targetId: job.targetId,
      capabilityId: job.capability.id,
      units: job.units,
      endsAt: job.endsAt,
    };
  return { ...common, endsAt: job.endsAt };
}
const tokens = (context: unknown) =>
  countInput({
    instructions: citizenInstructions,
    context: JSON.stringify(context),
    history: [],
  });
const overhead = tokens({});
const blockTokens = (value: unknown) => Math.max(0, tokens(value) - overhead);

export function assembleContext(input: CompilationInput): {
  context: CompiledContext;
  audit: RetrievalAudit;
} {
  if (input.counts.due > memoryPolicy.maxObligations)
    throw new ThinkingError(
      "limited",
      "Too many due obligations for one decision; narrow the decision rather than dropping obligations.",
    );
  const initialMemories = input.base.memories as
    { initial?: unknown[]; recent?: unknown[] } | undefined;
  const diverse = diverseMemories(
    input.retrieval.candidates,
    memoryPolicy.maxSelected,
  );
  const chosen = diverse.map((item) => ({
    id: item.memory.id,
    logicalId: item.memory.logicalId,
    version: item.memory.version,
    kind: item.memory.kind,
    certainty: item.memory.certainty,
    title: item.memory.title,
    text: item.memory.text.slice(0, 1600),
    truncated: item.memory.text.length > 1600,
    sourceIds: item.memory.sourceIds,
    eventStartMs: item.memory.eventStartMs,
    eventEndMs: item.memory.eventEndMs,
    availableSequence: item.memory.availableSequence,
    historicalExperience: true,
    projectIds: item.memory.payload.projectIds ?? [],
    routine: item.memory.payload.routine ?? null,
  }));
  while (chosen.length && blockTokens(chosen) > memoryPolicy.retrievedTokens)
    chosen.pop();
  const commitments = input.commitments.slice(0, memoryPolicy.maxObligations);
  const context: CompiledContext = {
    ...input.base,
    obligations: {
      current: commitments,
      acceptedCount: input.counts.accepted,
      dueCount: input.counts.due,
      omittedCount: Math.max(
        0,
        input.counts.accepted -
          commitments.filter((item) => item.status === "accepted").length,
      ),
    },
    relatedCommitmentState: input.relatedCommitments,
    recentActions: input.recentActions,
    memories: {
      variant: memoryPolicy.variant,
      initial: (initialMemories?.initial ?? []).slice(0, 8),
      recent: (initialMemories?.recent ?? []).slice(0, 12),
      retrieved: chosen,
      evidence: input.evidence.slice(0, 12).map((source) => ({
        id: source.id,
        actorId: source.actorId,
        sequence: source.sequence,
        simTimeMs: source.simTimeMs,
        content: source.content.slice(0, 600),
        truncated: source.content.length > 600,
      })),
      pending: {
        episodes: input.pending.episodes,
        windowLimited:
          input.pending.episodes.length >= 4 ||
          input.pending.sources.length > 8,
        omittedSources: Math.max(0, input.pending.sources.length - 8),
        sources: [...input.pending.sources]
          .sort((a, b) => b.sequence - a.sequence)
          .slice(0, 8)
          .map((source) => ({
            id: source.id,
            actorId: source.actorId,
            sequence: source.sequence,
            simTimeMs: source.simTimeMs,
            content: source.content.slice(0, 600),
            truncated: source.content.length > 600,
          })),
      },
    },
    knowledgeRules: {
      currentState:
        "Fresh visible surroundings and the as-of commitment ledger take precedence over historical descriptions.",
      pending:
        "Unprocessed speech may amend an older agreement. Do not treat the last parsed terms as uncontested when new relevant speech is pending.",
      interpretations:
        "Beliefs, reported claims, summaries and routines are qualified; a historical stock observation does not establish current remote stock.",
      evidence:
        "Source IDs are pointers to original evidence; excerpts may be truncated. Open a source when the missing detail matters.",
    },
    compilation: {
      mode: input.retrieval.mode,
      fallback: input.retrieval.fallback,
      pendingIndexes: input.retrieval.pendingIndexes,
      candidateCount: input.retrieval.candidates.length,
      additionalInitialMemories: Math.max(
        0,
        (initialMemories?.initial?.length ?? 0) - 8,
      ),
    },
  };
  while (tokens(context) > memoryPolicy.contextTokens - 256) {
    if (context.memories.retrieved.length) context.memories.retrieved.pop();
    else if (context.memories.evidence.length) context.memories.evidence.pop();
    else if (context.memories.recent.length) context.memories.recent.pop();
    else if (context.memories.initial.length) context.memories.initial.pop();
    else
      throw new ThinkingError(
        "limited",
        "Essential identity, state and obligations exceed the context budget; the decision must be narrowed.",
      );
  }
  const selectedIds = context.memories.retrieved.map((item) => item.id),
    selected = new Set(selectedIds);
  const sourceIds = (items: unknown[]) =>
    items.flatMap((item) =>
      item &&
      typeof item === "object" &&
      "id" in item &&
      typeof item.id === "string"
        ? [item.id]
        : [],
    );
  const audit: RetrievalAudit = {
    query: input.retrieval.query,
    mode: input.retrieval.mode,
    fallback: input.retrieval.fallback,
    pendingIndexes: input.retrieval.pendingIndexes,
    candidates: input.retrieval.candidates.map((item) => ({
      id: item.memory.id,
      score: item.score,
      channels: item.channels,
      sourceIds: item.memory.sourceIds,
    })),
    selectedIds,
    selectedSourceIds: [
      ...new Set([
        ...context.memories.retrieved.flatMap((item) => item.sourceIds),
        ...commitments.flatMap((item) => item.sourceIds),
        ...context.memories.evidence.map((item) => item.id),
        ...input.relatedCommitments.flatMap((item) => item.sourceIds),
        ...sourceIds(context.memories.initial),
        ...sourceIds(context.memories.recent),
        ...sourceIds(context.memories.pending.sources),
      ]),
    ],
    omitted: input.retrieval.candidates
      .filter((item) => !selected.has(item.memory.id))
      .map((item) => ({
        id: item.memory.id,
        reason: diverse.some(
          (candidate) => candidate.memory.id === item.memory.id,
        )
          ? "context token budget"
          : "redundant evidence or candidate limit",
      })),
    tokens: {
      instructionsAndTools: overhead,
      obligations: blockTokens(context.obligations),
      memories: blockTokens(context.memories),
      recentActions: blockTokens(context.recentActions),
      total: tokens(context),
    },
  };
  return { context, audit };
}
export class ContextCompiler {
  constructor(
    readonly memory: MemoryStore,
    readonly queries: MemoryQueries,
  ) {}
  async compile(state: WorldState, guard: AgentGuard, reasons: string[]) {
    const { runId } = state,
      citizenId = guard.citizenId,
      boundary = state.sequence;
    const [recent, commitments, counts, pending, recentActions] =
      await Promise.all([
        this.memory.sources(runId, citizenId, boundary, undefined, 20),
        this.memory.commitments(runId, citizenId, boundary),
        this.memory.obligationCounts(
          runId,
          citizenId,
          boundary,
          state.simTimeMs,
        ),
        this.memory.pendingSources(runId, citizenId, boundary),
        this.memory.recentActions(runId, citizenId, boundary),
      ]);
    const base = buildContext(
      state,
      citizenId,
      recent.map((source) => ({
        id: source.id,
        citizenId,
        eventSequence: source.sequence,
        simTimeMs: source.simTimeMs,
        kind: source.kind,
        content: source.content,
        entityIds: source.entityIds,
      })),
      reasons,
    );
    const self = state.citizens[citizenId]!;
    const ownJob = self.actionId ? state.jobs[self.actionId] : null;
    base.self = { ...(base.self as object), job: jobView(ownJob) };
    const places = base.knownPlaces as { id: string }[];
    base.knownPlaces = places.slice(0, 40);
    base.additionalKnownPlaces = Math.max(0, places.length - 40);
    const visible = base.surroundings as {
      objects: { id: string; capabilities?: unknown[] }[];
      citizens: { id: string; position: { x: number; y: number } }[];
    };
    base.affordances = visible.objects.map((item) => {
      const object = state.objects[item.id]!;
      return {
        targetId: object.id,
        advertisedCapabilityIds:
          object.capabilities && "capabilities" in item
            ? object.capabilities.map((capability) => capability.id)
            : null,
        sleepTool:
          object.tags.includes("bed") &&
          (!object.ownerId || object.ownerId === citizenId)
            ? "time_sleep"
            : null,
        standingOnTarget:
          self.position.x === object.position.x &&
          self.position.y === object.position.y,
        visibleOccupantId:
          visible.citizens.find(
            (citizen) =>
              citizen.position.x === object.position.x &&
              citizen.position.y === object.position.y,
          )?.id ?? null,
      };
    });
    const goal = self.plan?.goal ?? self.motivations.slice(0, 2).join(" ");
    const latestSpeech = recent.find(
      (source) => source.kind === "speech.delivered",
    );
    const query =
      `${goal} ${self.plan?.currentActivity ?? ""} ${latestSpeech?.content.slice(0, 160) ?? ""}`
        .trim()
        .slice(0, 600);
    const entities = [
      ...new Set([
        ...commitments.flatMap((item) => [
          item.debtorId,
          item.creditorId,
          `commitment:${item.logicalId}`,
        ]),
        ...recent.slice(0, 4).flatMap((item) => item.entityIds),
      ]),
    ];
    const retrieval = await this.queries.search(
      runId,
      citizenId,
      boundary,
      query,
      guard,
      entities,
    );
    const relatedIds = retrieval.candidates.flatMap((item) => {
      const direct = item.memory.payload.commitmentId;
      const projects = item.memory.payload.projectIds as string[] | undefined;
      return [
        ...(typeof direct === "string" ? [direct] : []),
        ...(projects ?? [])
          .filter((id) => id.startsWith("commitment:"))
          .map((id) => id.slice(11)),
      ];
    });
    const [evidence, relatedCommitments] = await Promise.all([
      this.memory.sources(
        runId,
        citizenId,
        boundary,
        [...new Set(commitments.flatMap((item) => item.sourceIds))].slice(
          0,
          100,
        ),
      ),
      this.memory.commitmentsByLogicalIds(
        runId,
        citizenId,
        boundary,
        relatedIds,
      ),
    ]);
    const result = assembleContext({
      base,
      commitments,
      counts,
      pending,
      evidence,
      recentActions: recentActions.map((item) => ({
        ...item,
        observedJob: item.receipt.jobId
          ? jobView(state.jobs[item.receipt.jobId])
          : null,
      })),
      retrieval,
      relatedCommitments,
    });
    await this.memory.saveAudit(
      `ctx-${guard.taskId}`,
      guard.taskId,
      runId,
      citizenId,
      boundary,
      result.audit,
    );
    return result;
  }
}
