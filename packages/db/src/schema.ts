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
    kind: text("kind", { enum: ["archive.checkpoint"] }).notNull(),
    payload: jsonb("payload").$type<ArchivePayload>().notNull(),
    status: text("status", {
      enum: ["pending", "queued", "completed", "failed"],
    }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("sim_background_tasks_status_idx").on(t.status, t.createdAt)],
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
