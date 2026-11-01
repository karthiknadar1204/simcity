import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
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
      enum: ["archive.checkpoint", "agent.think"],
    }).notNull(),
    payload: jsonb("payload")
      .$type<ArchivePayload | ThinkingPayload>()
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
