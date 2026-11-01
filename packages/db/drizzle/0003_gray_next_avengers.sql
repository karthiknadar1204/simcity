CREATE TABLE "sim_commitment_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"citizen_id" text NOT NULL,
	"logical_id" text NOT NULL,
	"version" integer NOT NULL,
	"debtor_id" text NOT NULL,
	"creditor_id" text NOT NULL,
	"resource" text NOT NULL,
	"amount" integer NOT NULL,
	"deadline_ms" bigint,
	"status" text NOT NULL,
	"origin_source_id" text NOT NULL,
	"source_ids" jsonb NOT NULL,
	"effective_sequence" bigint NOT NULL,
	"available_sequence" bigint NOT NULL,
	"superseded_sequence" bigint
);
--> statement-breakpoint
CREATE TABLE "sim_context_compilations" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text NOT NULL,
	"citizen_id" text NOT NULL,
	"boundary" bigint NOT NULL,
	"audit" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"citizen_id" text NOT NULL,
	"logical_id" text NOT NULL,
	"version" integer NOT NULL,
	"kind" text NOT NULL,
	"certainty" text NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"search_text" text NOT NULL,
	"text_hash" text NOT NULL,
	"source_ids" jsonb NOT NULL,
	"entity_ids" jsonb NOT NULL,
	"event_start_ms" bigint NOT NULL,
	"event_end_ms" bigint NOT NULL,
	"source_cutoff" bigint NOT NULL,
	"available_sequence" bigint NOT NULL,
	"superseded_sequence" bigint,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_memory_calls" (
	"task_id" text NOT NULL,
	"step" text NOT NULL,
	"run_id" text NOT NULL,
	"citizen_id" text NOT NULL,
	"request" jsonb NOT NULL,
	"answer" jsonb,
	"status" text NOT NULL,
	"reserved_micro_usd" integer NOT NULL,
	"cost_micro_usd" integer,
	"error" text,
	CONSTRAINT "sim_memory_calls_task_id_step_pk" PRIMARY KEY("task_id","step")
);
--> statement-breakpoint
CREATE TABLE "sim_memory_edges" (
	"run_id" text NOT NULL,
	"citizen_id" text NOT NULL,
	"from_id" text NOT NULL,
	"to_id" text NOT NULL,
	"relation" text NOT NULL,
	CONSTRAINT "sim_memory_edges_from_id_to_id_relation_pk" PRIMARY KEY("from_id","to_id","relation")
);
--> statement-breakpoint
CREATE TABLE "sim_memory_entities" (
	"memory_id" text NOT NULL,
	"run_id" text NOT NULL,
	"citizen_id" text NOT NULL,
	"entity_id" text NOT NULL,
	CONSTRAINT "sim_memory_entities_memory_id_entity_id_pk" PRIMARY KEY("memory_id","entity_id")
);
--> statement-breakpoint
CREATE TABLE "sim_memory_indexes" (
	"memory_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"text_hash" text NOT NULL,
	"embedding" vector(512),
	"available_sequence" bigint
);
--> statement-breakpoint
CREATE TABLE "sim_memory_members" (
	"run_id" text NOT NULL,
	"citizen_id" text NOT NULL,
	"source_id" text NOT NULL,
	"logical_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	CONSTRAINT "sim_memory_members_run_id_citizen_id_source_id_pk" PRIMARY KEY("run_id","citizen_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "sim_memory_sessions" (
	"run_id" text NOT NULL,
	"citizen_id" text NOT NULL,
	"key" text NOT NULL,
	"memory_id" text NOT NULL,
	"last_time_ms" bigint NOT NULL,
	CONSTRAINT "sim_memory_sessions_run_id_citizen_id_key_pk" PRIMARY KEY("run_id","citizen_id","key")
);
--> statement-breakpoint
CREATE TABLE "sim_memory_streams" (
	"run_id" text NOT NULL,
	"citizen_id" text NOT NULL,
	"processed_sequence" bigint DEFAULT 0 NOT NULL,
	"consolidated_cutoff" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "sim_memory_streams_run_id_citizen_id_pk" PRIMARY KEY("run_id","citizen_id")
);
--> statement-breakpoint
CREATE TABLE "sim_memory_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"citizen_id" text NOT NULL,
	"operation" text NOT NULL,
	"memory_id" text,
	"cutoff" bigint NOT NULL,
	"owner_id" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"outcome" jsonb
);
--> statement-breakpoint
CREATE TABLE "sim_memory_query_embeddings" (
	"run_id" text NOT NULL,
	"citizen_id" text NOT NULL,
	"text_hash" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"embedding" vector(512) NOT NULL,
	CONSTRAINT "sim_memory_query_embeddings_run_id_citizen_id_text_hash_model_pk" PRIMARY KEY("run_id","citizen_id","text_hash","model")
);
--> statement-breakpoint
ALTER TABLE "sim_commitment_versions" ADD CONSTRAINT "sim_commitment_versions_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_context_compilations" ADD CONSTRAINT "sim_context_compilations_task_id_sim_background_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."sim_background_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_context_compilations" ADD CONSTRAINT "sim_context_compilations_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memories" ADD CONSTRAINT "sim_memories_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memory_calls" ADD CONSTRAINT "sim_memory_calls_task_id_sim_background_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."sim_background_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memory_calls" ADD CONSTRAINT "sim_memory_calls_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memory_edges" ADD CONSTRAINT "sim_memory_edges_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memory_edges" ADD CONSTRAINT "sim_memory_edges_from_id_sim_memories_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."sim_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memory_edges" ADD CONSTRAINT "sim_memory_edges_to_id_sim_memories_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."sim_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memory_entities" ADD CONSTRAINT "sim_memory_entities_memory_id_sim_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."sim_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memory_entities" ADD CONSTRAINT "sim_memory_entities_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memory_indexes" ADD CONSTRAINT "sim_memory_indexes_memory_id_sim_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."sim_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memory_members" ADD CONSTRAINT "sim_memory_members_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memory_sessions" ADD CONSTRAINT "sim_memory_sessions_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memory_sessions" ADD CONSTRAINT "sim_memory_sessions_memory_id_sim_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."sim_memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memory_streams" ADD CONSTRAINT "sim_memory_streams_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memory_tasks" ADD CONSTRAINT "sim_memory_tasks_id_sim_background_tasks_id_fk" FOREIGN KEY ("id") REFERENCES "public"."sim_background_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memory_tasks" ADD CONSTRAINT "sim_memory_tasks_memory_id_sim_memories_id_fk" FOREIGN KEY ("memory_id") REFERENCES "public"."sim_memories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_memory_query_embeddings" ADD CONSTRAINT "sim_memory_query_embeddings_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sim_commitments_version_idx" ON "sim_commitment_versions" USING btree ("run_id","citizen_id","logical_id","version");--> statement-breakpoint
CREATE INDEX "sim_commitments_due_idx" ON "sim_commitment_versions" USING btree ("run_id","citizen_id","status","deadline_ms","superseded_sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "sim_memories_version_idx" ON "sim_memories" USING btree ("run_id","citizen_id","logical_id","version");--> statement-breakpoint
CREATE INDEX "sim_memories_scope_idx" ON "sim_memories" USING btree ("run_id","citizen_id","available_sequence");--> statement-breakpoint
CREATE INDEX "sim_memories_current_idx" ON "sim_memories" USING btree ("run_id","citizen_id","kind","superseded_sequence");--> statement-breakpoint
CREATE INDEX "sim_memories_text_idx" ON "sim_memories" USING gin (to_tsvector('english', "search_text"));--> statement-breakpoint
CREATE INDEX "sim_memory_edges_scope_idx" ON "sim_memory_edges" USING btree ("run_id","citizen_id","from_id");--> statement-breakpoint
CREATE INDEX "sim_memory_entities_lookup_idx" ON "sim_memory_entities" USING btree ("run_id","citizen_id","entity_id");--> statement-breakpoint
CREATE INDEX "sim_memory_indexes_vector_idx" ON "sim_memory_indexes" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "sim_memory_members_episode_idx" ON "sim_memory_members" USING btree ("run_id","citizen_id","logical_id");--> statement-breakpoint
CREATE INDEX "sim_memory_tasks_owner_idx" ON "sim_memory_tasks" USING btree ("citizen_id","lease_until");