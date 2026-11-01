CREATE TABLE "sim_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"object_key" text NOT NULL,
	"checksum" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_background_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_checkpoints" (
	"run_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"sim_time_ms" bigint NOT NULL,
	"state" jsonb NOT NULL,
	"state_hash" text NOT NULL,
	CONSTRAINT "sim_checkpoints_run_id_sequence_pk" PRIMARY KEY("run_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "sim_commands" (
	"run_id" text NOT NULL,
	"id" text NOT NULL,
	"request" jsonb NOT NULL,
	"receipt" jsonb NOT NULL,
	CONSTRAINT "sim_commands_run_id_id_pk" PRIMARY KEY("run_id","id")
);
--> statement-breakpoint
CREATE TABLE "sim_events" (
	"run_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"sim_time_ms" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "sim_events_run_id_sequence_pk" PRIMARY KEY("run_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "sim_observations" (
	"run_id" text NOT NULL,
	"citizen_id" text NOT NULL,
	"event_sequence" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "sim_observations_run_id_citizen_id_event_sequence_pk" PRIMARY KEY("run_id","citizen_id","event_sequence")
);
--> statement-breakpoint
CREATE TABLE "sim_outbox" (
	"task_id" text PRIMARY KEY NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sim_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"scenario" jsonb NOT NULL,
	"manifest" jsonb NOT NULL,
	"state" jsonb NOT NULL,
	"state_hash" text NOT NULL,
	"sequence" bigint NOT NULL,
	"sim_time_ms" bigint NOT NULL,
	"status" text NOT NULL,
	"owner_id" text,
	"owner_generation" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sim_artifacts" ADD CONSTRAINT "sim_artifacts_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_background_tasks" ADD CONSTRAINT "sim_background_tasks_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_checkpoints" ADD CONSTRAINT "sim_checkpoints_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_commands" ADD CONSTRAINT "sim_commands_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_events" ADD CONSTRAINT "sim_events_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_observations" ADD CONSTRAINT "sim_observations_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_outbox" ADD CONSTRAINT "sim_outbox_task_id_sim_background_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."sim_background_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_artifacts_run_idx" ON "sim_artifacts" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "sim_background_tasks_status_idx" ON "sim_background_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "sim_events_time_idx" ON "sim_events" USING btree ("run_id","sim_time_ms","sequence");--> statement-breakpoint
CREATE INDEX "sim_observations_scope_idx" ON "sim_observations" USING btree ("run_id","citizen_id","event_sequence");--> statement-breakpoint
CREATE INDEX "sim_runs_status_idx" ON "sim_runs" USING btree ("status");