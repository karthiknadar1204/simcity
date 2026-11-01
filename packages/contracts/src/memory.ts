import { z } from "zod";
import type { Action, Receipt } from "./types";

export const memoryPolicy = {
  version: "memory-v1",
  variant: "episodic-hybrid-v1",
  extractionModel: "gpt-5.4-mini-2026-03-17",
  embeddingModel: "text-embedding-3-small",
  dimensions: 512,
  embeddingMicroUsdPerToken: 0.02,
  maxSources: 24,
  maxEpisodeCharacters: 12000,
  conversationGapMs: 300000,
  contextTokens: 8000,
  retrievedTokens: 2200,
  maxCandidates: 40,
  maxSelected: 8,
  maxLinks: 12,
  maxObligations: 12,
  maxRecentActions: 6,
  maxInputTokens: 6000,
  maxOutputTokens: 1800,
  timeoutMs: 20000,
  leaseMs: 30000,
  concurrency: 1,
  attempts: 3,
} as const;

export type MemoryKind =
  "episode" | "proposal" | "belief" | "relationship" | "reflection" | "routine";
export type MemoryCertainty =
  "observed" | "reported" | "inferred" | "tentative";
export interface MemorySource {
  id: string;
  citizenId: string;
  sequence: number;
  simTimeMs: number;
  kind: string;
  content: string;
  actorId: string | null;
  participantIds: string[];
  entityIds: string[];
  action?: Action;
  receipt?: Receipt;
  result?: { jobId: string; kind: string; status: string };
}
export interface MemoryRecord {
  id: string;
  runId: string;
  citizenId: string;
  logicalId: string;
  version: number;
  kind: MemoryKind;
  certainty: MemoryCertainty;
  title: string;
  text: string;
  searchText: string;
  textHash: string;
  sourceIds: string[];
  entityIds: string[];
  eventStartMs: number;
  eventEndMs: number;
  sourceCutoff: number;
  availableSequence: number;
  supersededSequence: number | null;
  payload: Record<string, unknown>;
}
export interface CommitmentRecord {
  id: string;
  logicalId: string;
  version: number;
  runId: string;
  citizenId: string;
  debtorId: string;
  creditorId: string;
  resource: string;
  amount: number;
  deadlineMs: number | null;
  status: "accepted" | "cancelled" | "fulfilled";
  originSourceId: string;
  sourceIds: string[];
  effectiveSequence: number;
  availableSequence: number;
  supersededSequence: number | null;
}
export interface MemoryTaskPayload {
  runId: string;
  citizenId: string;
  memoryId: string | null;
  cutoff: number;
  operation: "extract" | "embed" | "consolidate";
}
const id = z.string().min(1).max(160);
export const evidenceQuoteSchema = z.strictObject({
  sourceId: id,
  quote: z.string().min(1).max(2000),
});
export type EvidenceQuote = z.infer<typeof evidenceQuoteSchema>;
export const agreementCandidateSchema = z.strictObject({
  operation: z.enum(["propose", "agree", "amend", "cancel"]),
  originSourceId: id,
  commitmentId: id.nullable(),
  debtorId: id,
  creditorId: id,
  resource: id,
  amount: z.number().int().min(1).max(1000000),
  deadlineMs: z.number().int().safe().nonnegative().nullable(),
  proposal: evidenceQuoteSchema,
  acceptance: evidenceQuoteSchema.nullable(),
  termsEvidence: z.array(evidenceQuoteSchema).min(1).max(6),
});
export type AgreementCandidate = z.infer<typeof agreementCandidateSchema>;
export const claimCandidateSchema = z.strictObject({
  kind: z.enum(["belief", "relationship", "reflection", "routine"]),
  title: z.string().min(1).max(160),
  text: z.string().min(1).max(1600),
  entityIds: z.array(id).max(12),
  evidence: z.array(evidenceQuoteSchema).min(1).max(8),
});
export type ClaimCandidate = z.infer<typeof claimCandidateSchema>;
export const memoryExtractionSchema = z.strictObject({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(2400),
  summaryEvidence: z.array(evidenceQuoteSchema).min(1).max(12),
  agreements: z.array(agreementCandidateSchema).max(8),
  claims: z.array(claimCandidateSchema).max(8),
});
export type MemoryExtraction = z.infer<typeof memoryExtractionSchema>;
export interface RetrievedMemory {
  memory: MemoryRecord;
  score: number;
  channels: string[];
}
export interface MemoryRetrieval {
  query: string;
  asOf: number;
  candidates: RetrievedMemory[];
  mode: "text" | "hybrid";
  pendingIndexes: number;
  sourceIds: string[];
  fallback: string | null;
}
