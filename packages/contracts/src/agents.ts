import { z } from "zod";

export const agentPolicy = {
  version: "phase4-v2",
  model: "gpt-5.4-mini-2026-03-17",
  promptVersion: "citizen-v5",
  toolVersion: "citizen-tools-v4",
  contextTokens: 16000,
  maxOutputTokens: 1400,
  maxRounds: 6,
  maxSearches: 2,
  maxRequests: 2000,
  spendingLimitMicroUsd: 1000000,
  inputMicroUsdPerToken: 0.75,
  outputMicroUsdPerToken: 4.5,
  concurrency: 2,
  leaseMs: 30000,
  timeoutMs: 20000,
  debounceMs: 1000,
  idleReviewMs: 30000,
  attentionEnergy: 100,
  attentionHunger: 700,
  retryReviewMs: 60000,
} as const;

export const planProposalSchema = z.strictObject({
  dayOutline: z
    .array(
      z.strictObject({
        window: z.string().min(1).max(80),
        activity: z.string().min(1).max(160),
      }),
    )
    .min(1)
    .max(12),
  goal: z.string().min(1).max(300),
  currentActivity: z.string().min(1).max(160),
  knownConstraints: z.array(z.string().max(160)).max(8),
  steps: z.array(z.string().min(1).max(160)).min(1).max(10),
  cursor: z.number().int().nonnegative().max(9),
  blocker: z.string().max(200).nullable(),
  reviewAfterMs: z.number().int().min(5000).max(600000),
  evidenceIds: z.array(z.string().max(160)).max(12),
  briefReason: z.string().min(1).max(400),
});
export type PlanProposal = z.infer<typeof planProposalSchema>;
export type CitizenPlan = PlanProposal & {
  version: number;
  updatedAtMs: number;
  nextReviewAtMs: number;
};
export interface AgentConfiguration {
  provider: "openai" | "fixture";
  citizenId: string;
  model: string;
  spendingLimitMicroUsd: number;
  maxRequests: number;
  memory?: boolean;
}
export interface ThinkingPayload {
  runId: string;
  citizenId: string;
  version: number;
}
export interface AgentGuard {
  taskId: string;
  ownerId: string;
  generation: number;
  citizenId: string;
  version: number;
}
export interface ModelCall {
  callId: string;
  name: string;
  arguments: string;
}
export interface ModelAnswer {
  completion?: "completed" | "incomplete";
  responseId: string;
  model: string;
  output: unknown[];
  call: ModelCall | null;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}
export interface ToolOutcome {
  status: string;
  data?: unknown;
  reason?: string;
  yield?: boolean;
}
