import {
  memoryPolicy,
  type MemoryCallRequest,
  type MemoryRecord,
} from "@repo/contracts";
import {
  MemoryStore,
  MemoryWorkStore,
  publishMemoryAnswer,
  ThinkingError,
  type MemoryClaim,
} from "@repo/storage";
import { ModelRequestRejected } from "../openai";
import { memoryInputTokens, type MemoryModel } from "./openai";
import { consolidationInstructions, extractionInstructions } from "./prompt";

export class MemoryRunner {
  readonly ownerId = crypto.randomUUID();
  constructor(
    readonly memory: MemoryStore,
    readonly work: MemoryWorkStore,
    readonly model: MemoryModel,
    readonly allowFixtures = false,
  ) {}
  async requestFor(claim: MemoryClaim): Promise<MemoryCallRequest | null> {
    const { payload } = claim;
    let selected: MemoryRecord[];
    if (payload.memoryId) {
      const found = await this.memory.read(
        payload.runId,
        payload.citizenId,
        payload.cutoff,
        payload.memoryId,
      );
      if (!found || found.kind !== "memory")
        throw new Error("Pinned memory version is unavailable.");
      selected = [found.memory];
      if (payload.operation === "embed") {
        const request = {
          kind: "embed" as const,
          model: memoryPolicy.embeddingModel,
          instructions: "",
          input: found.memory.searchText,
        };
        return { ...request, inputTokens: memoryInputTokens(request) };
      }
    } else {
      const stream = await this.memory.stream(payload.runId, payload.citizenId);
      selected = await this.memory.consolidationBatch(
        payload.runId,
        payload.citizenId,
        payload.cutoff,
        stream?.consolidatedCutoff ?? 0,
      );
      if (!selected.length) return null;
    }
    while (selected.length) {
      const coverageCutoff = Math.max(
        ...selected.map((item) => item.sourceCutoff),
      );
      const memberIds = [
        ...new Set(selected.flatMap((item) => item.sourceIds)),
      ];
      if (
        payload.operation === "consolidate" &&
        memberIds.length > memoryPolicy.maxSources
      ) {
        selected.pop();
        continue;
      }
      const commitments =
        payload.operation === "consolidate"
          ? []
          : await this.memory.commitments(
              payload.runId,
              payload.citizenId,
              payload.cutoff,
              100,
            );
      const ids = [
        ...new Set([
          ...memberIds,
          ...commitments.slice(0, 12).flatMap((item) => item.sourceIds),
        ]),
      ].slice(0, 100);
      const sources = await this.memory.sources(
        payload.runId,
        payload.citizenId,
        payload.cutoff,
        ids,
      );
      sources.sort(
        (a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id),
      );
      if (!sources.length) return null;
      const previous =
        payload.operation === "extract" && selected[0]
          ? await this.memory.logicalHead(
              payload.runId,
              payload.citizenId,
              payload.cutoff,
              `summary:${selected[0].logicalId}`,
            )
          : null;
      const newSourceIds = sources
        .filter(
          (source) =>
            memberIds.includes(source.id) &&
            source.sequence > (previous?.sourceCutoff ?? -1),
        )
        .map((source) => source.id);
      const entities = new Set(
        sources.flatMap((source) => [
          ...source.entityIds,
          ...source.participantIds,
        ]),
      );
      const request = {
        kind: payload.operation,
        model: memoryPolicy.extractionModel,
        instructions:
          payload.operation === "consolidate"
            ? consolidationInstructions
            : extractionInstructions,
        input: JSON.stringify({
          citizenId: payload.citizenId,
          newSourceIds,
          sourceCutoff: payload.cutoff,
          coverageCutoff,
          dayLengthMs: claim.state.rules.dayLengthMs,
          memoryIds: selected.map((item) => item.id),
          sources,
          commitments: commitments.slice(0, 12),
          entities: [
            ...Object.values(claim.state.citizens),
            ...Object.values(claim.state.objects),
          ]
            .filter((entity) => entities.has(entity.id))
            .map((entity) => ({ id: entity.id, name: entity.name })),
        }),
      };
      const inputTokens = memoryInputTokens(request);
      if (inputTokens <= memoryPolicy.maxInputTokens)
        return { ...request, inputTokens };
      if (payload.operation !== "consolidate")
        throw new ThinkingError(
          "limited",
          "Episode extraction input exceeds its bounded policy; raw evidence remains searchable.",
        );
      selected.pop();
    }
    throw new ThinkingError(
      "limited",
      "A consolidation segment exceeds its input budget; original evidence was retained.",
    );
  }
  async run(taskId: string) {
    const claim = await this.work.begin(
      taskId,
      this.ownerId,
      this.allowFixtures,
    );
    if (!claim) return;
    const { guard, payload } = claim;
    const abort = new AbortController();
    let renewing = false,
      inFlight = false;
    const timer = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.work
        .heartbeat(guard)
        .then((valid) => {
          if (!valid) abort.abort();
        })
        .catch(() => abort.abort())
        .finally(() => {
          renewing = false;
        });
    }, 5000);
    try {
      let call = await this.work.call(taskId, "main");
      if (!call) {
        const request = await this.requestFor(claim);
        if (!request) {
          await this.work.finish(payload.runId, guard);
          return;
        }
        call = await this.work.reserveCall(
          payload.runId,
          payload.citizenId,
          guard,
          "main",
          request,
        );
        inFlight = true;
        const answer = await this.model.respond(request, abort.signal);
        await this.work.saveAnswer(payload.runId, guard, "main", answer);
        inFlight = false;
        call = { ...call, status: "responded", answer };
      } else if (call.status !== "responded") {
        if (call.status === "reserved")
          await this.work.settleFailure(payload.runId, guard, "main", false);
        await this.work.finish(
          payload.runId,
          guard,
          "Previous memory request was rejected or has uncertain delivery. Retry explicitly with a new task.",
        );
        return;
      }
      if (!call.answer || call.answer.error || call.answer.data === null) {
        await this.work.finish(
          payload.runId,
          guard,
          call.answer?.error ?? "No valid memory output was available.",
        );
        return;
      }
      await publishMemoryAnswer(this.work.db, guard, payload, call.answer);
    } catch (error) {
      if (inFlight)
        await this.work
          .settleFailure(
            payload.runId,
            guard,
            "main",
            error instanceof ModelRequestRejected,
          )
          .catch(() => undefined);
      if (error instanceof ThinkingError && error.code === "stale") return;
      const detail =
        error instanceof ModelRequestRejected || error instanceof ThinkingError
          ? error.message.slice(0, 300)
          : error instanceof Error
            ? error.name
            : "MemoryError";
      await this.work
        .finish(
          payload.runId,
          guard,
          `Memory work failed: ${detail}. Original sources are retained.`,
        )
        .catch(() => undefined);
    } finally {
      clearInterval(timer);
      while (renewing) await Bun.sleep(10);
      await this.work.release(guard).catch(() => undefined);
    }
  }
}
