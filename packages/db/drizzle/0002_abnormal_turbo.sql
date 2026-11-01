CREATE TABLE "sim_agent_budgets" (
	"run_id" text PRIMARY KEY NOT NULL,
	"limit_micro_usd" integer NOT NULL,
	"max_requests" integer NOT NULL,
	"spent_micro_usd" integer DEFAULT 0 NOT NULL,
	"reserved_micro_usd" integer DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_agent_controls" (
	"run_id" text NOT NULL,
	"citizen_id" text NOT NULL,
	"configuration" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"task_id" text,
	"next_review_at_ms" bigint NOT NULL,
	"last_decision_at_ms" bigint DEFAULT 0 NOT NULL,
	"pending_reasons" jsonb NOT NULL,
	"error" text,
	CONSTRAINT "sim_agent_controls_run_id_citizen_id_pk" PRIMARY KEY("run_id","citizen_id")
);
--> statement-breakpoint
CREATE TABLE "sim_model_rounds" (
	"task_id" text NOT NULL,
	"round" integer NOT NULL,
	"status" text NOT NULL,
	"request" jsonb NOT NULL,
	"answer" jsonb,
	"outcome" jsonb,
	"reserved_micro_usd" integer NOT NULL,
	"cost_micro_usd" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sim_model_rounds_task_id_round_pk" PRIMARY KEY("task_id","round")
);
--> statement-breakpoint
CREATE TABLE "sim_thinking_turns" (
	"id" text PRIMARY KEY NOT NULL,
	"citizen_id" text NOT NULL,
	"version" integer NOT NULL,
	"boundary_sequence" bigint,
	"context" jsonb,
	"reasons" jsonb NOT NULL,
	"available_at_ms" bigint NOT NULL,
	"owner_id" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"outcome" text
);
--> statement-breakpoint
ALTER TABLE "sim_agent_budgets" ADD CONSTRAINT "sim_agent_budgets_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_agent_controls" ADD CONSTRAINT "sim_agent_controls_run_id_sim_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."sim_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_model_rounds" ADD CONSTRAINT "sim_model_rounds_task_id_sim_thinking_turns_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."sim_thinking_turns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_thinking_turns" ADD CONSTRAINT "sim_thinking_turns_id_sim_background_tasks_id_fk" FOREIGN KEY ("id") REFERENCES "public"."sim_background_tasks"("id") ON DELETE cascade ON UPDATE no action;