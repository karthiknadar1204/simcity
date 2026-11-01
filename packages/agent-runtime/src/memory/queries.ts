import {
  contentHash,
  memoryPolicy,
  type AgentGuard,
  type MemoryRetrieval,
  type MemoryCallRequest,
} from "@repo/contracts";
import { MemoryStore, MemoryWorkStore, ThinkingError } from "@repo/storage";
import { ModelRequestRejected } from "../openai";
import { memoryInputTokens, type MemoryModel } from "./openai";

export class MemoryQueries {
  constructor(
    readonly memory: MemoryStore,
    readonly work: MemoryWorkStore,
    readonly model: MemoryModel,
  ) {}
  async search(
    runId: string,
    citizenId: string,
    boundary: number,
    query: string,
    guard: AgentGuard,
    entities: string[] = [],
  ): Promise<MemoryRetrieval> {
    const input = query.trim().slice(0, 1000),
      textHash = await contentHash(input);
    let vector = await this.memory.cachedQuery(runId, citizenId, textHash);
    let fallback: string | null = null,
      inFlight = false;
    const step = `query-${textHash.slice(0, 40)}`;
    try {
      if (!vector) {
        const base = {
          kind: "query" as const,
          model: memoryPolicy.embeddingModel,
          instructions: "",
          input,
        };
        const request: MemoryCallRequest = {
          ...base,
          inputTokens: memoryInputTokens(base),
        };
        const prior = await this.work.call(guard.taskId, step);
        let answer = prior?.answer;
        if (prior && prior.status !== "responded") {
          if (prior.status === "reserved")
            await this.work.settleFailure(runId, guard, step, false);
          throw new Error("Query embedding request is rejected or uncertain.");
        }
        if (!prior) {
          await this.work.reserveCall(runId, citizenId, guard, step, request);
          inFlight = true;
          answer = await this.model.respond(
            request,
            AbortSignal.timeout(memoryPolicy.timeoutMs),
          );
          await this.work.saveAnswer(runId, guard, step, answer);
          inFlight = false;
        }
        if (!answer || answer.error || !Array.isArray(answer.data))
          throw new Error("Query embedding is unavailable.");
        vector = answer.data;
        await this.memory.cacheQuery(runId, citizenId, textHash, vector);
      }
    } catch (error) {
      if (inFlight)
        await this.work
          .settleFailure(
            runId,
            guard,
            step,
            error instanceof ModelRequestRejected,
          )
          .catch(() => undefined);
      if (
        error instanceof ThinkingError &&
        (error.code === "stale" || error.code === "paused")
      )
        throw error;
      fallback =
        error instanceof ThinkingError
          ? error.message
          : error instanceof ModelRequestRejected
            ? "Embedding provider rejected the request; scoped text fallback used."
            : "Query embedding unavailable; scoped text fallback used.";
    }
    const retrieved = await this.memory.search(
      runId,
      citizenId,
      boundary,
      input,
      vector,
      entities,
    );
    return { ...retrieved, fallback: fallback ?? retrieved.fallback };
  }
}
