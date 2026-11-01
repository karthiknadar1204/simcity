import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  Command,
  Observation,
  Receipt,
  RunManifest,
  Scenario,
  WorldEvent,
  WorldState,
  AgentConfiguration,
  ThinkingPayload,
  ModelAnswer,
  ToolOutcome,
  MemoryKind,
  MemoryCertainty,
  MemoryTaskPayload,
  MemoryExtraction,
} from "@repo/contracts";

export const runs = pgTable(
  "sim_runs",
  {
    id: text("id").primaryKey(),
    scenario: jsonb("scenario").$type<Scenario>().notNull(),
    manifest: jsonb("manifest").$type<RunManifest>().notNull(),
    state: jsonb("state").$type<WorldState>().notNull(),
    stateHash: text("state_hash").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    simTimeMs: bigint("sim_time_ms", { mode: "number" }).notNull(),
    status: text("status", { enum: ["running", "paused"] }).notNull(),
    ownerId: text("owner_id"),
    ownerGeneration: integer("owner_generation").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("sim_runs_status_idx").on(t.status)],
);

export const events = pgTable(
  "sim_events",
  {
    runId: text("run_id")
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    simTimeMs: bigint("sim_time_ms", { mode: "number" }).notNull(),
    payload: jsonb("payload").$type<WorldEvent>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.sequence] }),
    index("sim_events_time_idx").on(t.runId, t.simTimeMs, t.sequence),
  ],
);

export const observations = pgTable(
  "sim_observations",
  {
    runId: text("run_id")
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    citizenId: text("citizen_id").notNull(),
    eventSequence: bigint("event_sequence", { mode: "number" }).notNull(),
    payload: jsonb("payload").$type<Observation>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.citizenId, t.eventSequence] }),
    index("sim_observations_scope_idx").on(
      t.runId,
      t.citizenId,
      t.eventSequence,
    ),
  ],
);

export const commands = pgTable(
  "sim_commands",
  {
    runId: text("run_id")
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    id: text("id").notNull(),
    request: jsonb("request").$type<Command>().notNull(),
    receipt: jsonb("receipt").$type<Receipt>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.id] })],
);

export const checkpoints = pgTable(
  "sim_checkpoints",
  {
    runId: text("run_id")
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    simTimeMs: bigint("sim_time_ms", { mode: "number" }).notNull(),
    state: jsonb("state").$type<WorldState>().notNull(),
    stateHash: text("state_hash").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.sequence] })],
);

export type ArchivePayload = { runId: string; sequence: number };
export const backgroundTasks = pgTable(
  "sim_background_tasks",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind", {
      enum: [
        "archive.checkpoint",
        "agent.think",
        "memory.extract",
        "memory.embed",
        "memory.consolidate",
      ],
    }).notNull(),
    payload: jsonb("payload")
      .$type<ArchivePayload | ThinkingPayload | MemoryTaskPayload>()
      .notNull(),
    status: text("status", {
      enum: [
        "pending",
        "queued",
        "running",
        "completed",
        "failed",
        "superseded",
      ],
    }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("sim_background_tasks_status_idx").on(t.status, t.createdAt)],
);

export const agentControls = pgTable(
  "sim_agent_controls",
  {
    runId: text("run_id")
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    citizenId: text("citizen_id").notNull(),
    configuration: jsonb("configuration").$type<AgentConfiguration>().notNull(),
    version: integer("version").notNull().default(1),
    status: text("status", {
      enum: ["active", "disabled", "limited", "error"],
    }).notNull(),
    taskId: text("task_id"),
    nextReviewAtMs: bigint("next_review_at_ms", { mode: "number" }).notNull(),
    lastDecisionAtMs: bigint("last_decision_at_ms", { mode: "number" })
      .notNull()
      .default(0),
    pendingReasons: jsonb("pending_reasons").$type<string[]>().notNull(),
    error: text("error"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.citizenId] })],
);

export const agentBudgets = pgTable("sim_agent_budgets", {
  runId: text("run_id")
    .primaryKey()
    .references(() => runs.id, { onDelete: "cascade" }),
  limitMicroUsd: integer("limit_micro_usd").notNull(),
  maxRequests: integer("max_requests").notNull(),
  spentMicroUsd: integer("spent_micro_usd").notNull().default(0),
  reservedMicroUsd: integer("reserved_micro_usd").notNull().default(0),
  requests: integer("requests").notNull().default(0),
});

export const thinkingTurns = pgTable("sim_thinking_turns", {
  id: text("id")
    .primaryKey()
    .references(() => backgroundTasks.id, { onDelete: "cascade" }),
  citizenId: text("citizen_id").notNull(),
  version: integer("version").notNull(),
  boundarySequence: bigint("boundary_sequence", { mode: "number" }),
  context: jsonb("context").$type<Record<string, unknown>>(),
  reasons: jsonb("reasons").$type<string[]>().notNull(),
  availableAtMs: bigint("available_at_ms", { mode: "number" }).notNull(),
  ownerId: text("owner_id"),
  generation: integer("generation").notNull().default(0),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  outcome: text("outcome"),
});

export const modelRounds = pgTable(
  "sim_model_rounds",
  {
    taskId: text("task_id")
      .references(() => thinkingTurns.id, { onDelete: "cascade" })
      .notNull(),
    round: integer("round").notNull(),
    status: text("status", {
      enum: ["reserved", "responded", "applied", "uncertain", "rejected"],
    }).notNull(),
    request: jsonb("request")
      .$type<{
        instructions: string;
        context: string;
        history: unknown[];
        inputTokens: number;
        allowTextOnly?: boolean;
      }>()
      .notNull(),
    answer: jsonb("answer").$type<ModelAnswer>(),
    outcome: jsonb("outcome").$type<ToolOutcome>(),
    reservedMicroUsd: integer("reserved_micro_usd").notNull(),
    costMicroUsd: integer("cost_micro_usd"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.round] })],
);

export const outbox = pgTable("sim_outbox", {
  taskId: text("task_id")
    .primaryKey()
    .references(() => backgroundTasks.id, { onDelete: "cascade" }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
});

export const artifacts = pgTable(
  "sim_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .references(() => runs.id, { onDelete: "cascade" })
      .notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
    key: text("object_key").notNull(),
    checksum: text("checksum").notNull(),
    bytes: integer("bytes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("sim_artifacts_run_idx").on(t.runId, t.sequence)],
);

export const memories = pgTable(
  "sim_memories",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    citizenId: text("citizen_id").notNull(),
    logicalId: text("logical_id").notNull(),
    version: integer("version").notNull(),
    kind: text("kind").$type<MemoryKind>().notNull(),
    certainty: text("certainty").$type<MemoryCertainty>().notNull(),
    title: text("title").notNull(),
    text: text("text").notNull(),
    searchText: text("search_text").notNull(),
    textHash: text("text_hash").notNull(),
    sourceIds: jsonb("source_ids").$type<string[]>().notNull(),
    entityIds: jsonb("entity_ids").$type<string[]>().notNull(),
    eventStartMs: bigint("event_start_ms", { mode: "number" }).notNull(),
    eventEndMs: bigint("event_end_ms", { mode: "number" }).notNull(),
    sourceCutoff: bigint("source_cutoff", { mode: "number" }).notNull(),
    availableSequence: bigint("available_sequence", {
      mode: "number",
    }).notNull(),
    supersededSequence: bigint("superseded_sequence", { mode: "number" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    uniqueIndex("sim_memories_version_idx").on(
      t.runId,
      t.citizenId,
      t.logicalId,
      t.version,
    ),
    index("sim_memories_scope_idx").on(
      t.runId,
      t.citizenId,
      t.availableSequence,
    ),
    index("sim_memories_current_idx").on(
      t.runId,
      t.citizenId,
      t.kind,
      t.supersededSequence,
    ),
    index("sim_memories_text_idx").using(
      "gin",
      sql`to_tsvector('english', ${t.searchText})`,
    ),
  ],
);

export const memoryStreams = pgTable(
  "sim_memory_streams",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    citizenId: text("citizen_id").notNull(),
    processedSequence: bigint("processed_sequence", { mode: "number" })
      .notNull()
      .default(0),
    consolidatedCutoff: bigint("consolidated_cutoff", { mode: "number" })
      .notNull()
      .default(0),
  },
  (t) => [primaryKey({ columns: [t.runId, t.citizenId] })],
);

export const memorySessions = pgTable(
  "sim_memory_sessions",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    citizenId: text("citizen_id").notNull(),
    key: text("key").notNull(),
    memoryId: text("memory_id")
      .notNull()
      .references(() => memories.id),
    lastTimeMs: bigint("last_time_ms", { mode: "number" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.citizenId, t.key] })],
);

export const memoryMembers = pgTable(
  "sim_memory_members",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    citizenId: text("citizen_id").notNull(),
    sourceId: text("source_id").notNull(),
    logicalId: text("logical_id").notNull(),
    sequence: bigint("sequence", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.runId, t.citizenId, t.sourceId] }),
    index("sim_memory_members_episode_idx").on(
      t.runId,
      t.citizenId,
      t.logicalId,
    ),
  ],
);

export const memoryEntities = pgTable(
  "sim_memory_entities",
  {
    memoryId: text("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    citizenId: text("citizen_id").notNull(),
    entityId: text("entity_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.memoryId, t.entityId] }),
    index("sim_memory_entities_lookup_idx").on(
      t.runId,
      t.citizenId,
      t.entityId,
    ),
  ],
);

export const memoryEdges = pgTable(
  "sim_memory_edges",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    citizenId: text("citizen_id").notNull(),
    fromId: text("from_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    toId: text("to_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    relation: text("relation", {
      enum: ["continues", "supports", "summarizes", "supersedes"],
    }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fromId, t.toId, t.relation] }),
    index("sim_memory_edges_scope_idx").on(t.runId, t.citizenId, t.fromId),
  ],
);

export const memoryIndexes = pgTable(
  "sim_memory_indexes",
  {
    memoryId: text("memory_id")
      .primaryKey()
      .references(() => memories.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["pending", "ready", "failed", "superseded"],
    }).notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    textHash: text("text_hash").notNull(),
    embedding: vector("embedding", { dimensions: 512 }),
    availableSequence: bigint("available_sequence", { mode: "number" }),
  },
  (t) => [
    index("sim_memory_indexes_vector_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  ],
);

export const commitmentVersions = pgTable(
  "sim_commitment_versions",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    citizenId: text("citizen_id").notNull(),
    logicalId: text("logical_id").notNull(),
    version: integer("version").notNull(),
    debtorId: text("debtor_id").notNull(),
    creditorId: text("creditor_id").notNull(),
    resource: text("resource").notNull(),
    amount: integer("amount").notNull(),
    deadlineMs: bigint("deadline_ms", { mode: "number" }),
    status: text("status", {
      enum: ["accepted", "cancelled", "fulfilled"],
    }).notNull(),
    originSourceId: text("origin_source_id").notNull(),
    sourceIds: jsonb("source_ids").$type<string[]>().notNull(),
    effectiveSequence: bigint("effective_sequence", {
      mode: "number",
    }).notNull(),
    availableSequence: bigint("available_sequence", {
      mode: "number",
    }).notNull(),
    supersededSequence: bigint("superseded_sequence", { mode: "number" }),
  },
  (t) => [
    uniqueIndex("sim_commitments_version_idx").on(
      t.runId,
      t.citizenId,
      t.logicalId,
      t.version,
    ),
    index("sim_commitments_due_idx").on(
      t.runId,
      t.citizenId,
      t.status,
      t.deadlineMs,
      t.supersededSequence,
    ),
  ],
);

export const memoryTasks = pgTable(
  "sim_memory_tasks",
  {
    id: text("id")
      .primaryKey()
      .references(() => backgroundTasks.id, { onDelete: "cascade" }),
    citizenId: text("citizen_id").notNull(),
    operation: text("operation", {
      enum: ["extract", "embed", "consolidate"],
    }).notNull(),
    memoryId: text("memory_id").references(() => memories.id),
    cutoff: bigint("cutoff", { mode: "number" }).notNull(),
    ownerId: text("owner_id"),
    generation: integer("generation").notNull().default(0),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    outcome: jsonb("outcome").$type<{ accepted: number; rejected: string[] }>(),
  },
  (t) => [index("sim_memory_tasks_owner_idx").on(t.citizenId, t.leaseUntil)],
);

export interface MemoryCallRequest {
  kind: "extract" | "embed" | "consolidate" | "query";
  model: string;
  input: string;
  inputTokens: number;
}
export interface MemoryCallAnswer {
  model: string;
  data: MemoryExtraction | number[];
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}
export const memoryCalls = pgTable(
  "sim_memory_calls",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => backgroundTasks.id, { onDelete: "cascade" }),
    step: text("step").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    citizenId: text("citizen_id").notNull(),
    request: jsonb("request").$type<MemoryCallRequest>().notNull(),
    answer: jsonb("answer").$type<MemoryCallAnswer>(),
    status: text("status", {
      enum: ["reserved", "responded", "uncertain", "rejected"],
    }).notNull(),
    reservedMicroUsd: integer("reserved_micro_usd").notNull(),
    costMicroUsd: integer("cost_micro_usd"),
    error: text("error"),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.step] })],
);

export const queryEmbeddings = pgTable(
  "sim_memory_query_embeddings",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    citizenId: text("citizen_id").notNull(),
    textHash: text("text_hash").notNull(),
    model: text("model").notNull(),
    dimensions: integer("dimensions").notNull(),
    embedding: vector("embedding", { dimensions: 512 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.citizenId, t.textHash, t.model] })],
);

export interface RetrievalAudit {
  query: string;
  mode: "text" | "hybrid";
  fallback: string | null;
  pendingIndexes: number;
  candidates: {
    id: string;
    score: number;
    channels: string[];
    sourceIds: string[];
  }[];
  selectedIds: string[];
  selectedSourceIds: string[];
  omitted: { id: string; reason: string }[];
  tokens: Record<string, number>;
}
export const contextCompilations = pgTable("sim_context_compilations", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => backgroundTasks.id, { onDelete: "cascade" }),
  runId: text("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  citizenId: text("citizen_id").notNull(),
  boundary: bigint("boundary", { mode: "number" }).notNull(),
  audit: jsonb("audit").$type<RetrievalAudit>().notNull(),
});
