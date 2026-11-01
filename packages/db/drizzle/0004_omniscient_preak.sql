CREATE TABLE "sim_recording_chunks" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"from_sequence" bigint NOT NULL,
	"to_sequence" bigint NOT NULL,
	"start_ms" bigint NOT NULL,
	"end_ms" bigint NOT NULL,
	"manifest" jsonb
);
--> statement-breakpoint
CREATE TABLE "sim_video_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"files" jsonb,
	"owner_id" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "sim_thinking_turns" ADD COLUMN "finished_sequence" bigint;--> statement-breakpoint
ALTER TABLE "sim_recording_chunks" ADD CONSTRAINT "sim_recording_chunks_id_sim_background_tasks_id_fk" FOREIGN KEY ("id") REFERENCES "public"."sim_background_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_recording_chunks" ADD CONSTRAINT "sim_recording_chunks_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_video_exports" ADD CONSTRAINT "sim_video_exports_id_sim_background_tasks_id_fk" FOREIGN KEY ("id") REFERENCES "public"."sim_background_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_video_exports" ADD CONSTRAINT "sim_video_exports_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_recording_interval_idx" ON "sim_recording_chunks" USING btree ("run_id","from_sequence","to_sequence");--> statement-breakpoint
CREATE INDEX "sim_video_exports_run_idx" ON "sim_video_exports" USING btree ("run_id","id");