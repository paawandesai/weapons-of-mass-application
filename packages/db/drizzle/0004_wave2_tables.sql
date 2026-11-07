CREATE TYPE "public"."application_status" AS ENUM('pending', 'applied', 'interviewing', 'offer', 'closed');--> statement-breakpoint
CREATE TYPE "public"."ats_kind" AS ENUM('ashby', 'greenhouse', 'lever');--> statement-breakpoint
CREATE TYPE "public"."captcha_stage" AS ENUM('agent1', 'agent2', 'human');--> statement-breakpoint
CREATE TYPE "public"."company_source" AS ENUM('llm', 'user', 'hn');--> statement-breakpoint
CREATE TYPE "public"."confirmation_source" AS ENUM('page', 'email');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'finished', 'short_day', 'skipped_no_profile', 'failed');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('scheduled', 'manual');--> statement-breakpoint
CREATE TABLE "applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"run_id" uuid,
	"status" "application_status" DEFAULT 'pending' NOT NULL,
	"pending_reason" text,
	"closed_reason" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"resume_pdf_ref" text,
	"form_answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unmet_requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"applied_at" timestamp with time zone,
	"confirmation_source" "confirmation_source",
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applications_user_id_job_id_key" UNIQUE("user_id","job_id"),
	CONSTRAINT "applications_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "ats_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"ats" "ats_kind" NOT NULL,
	"company_id" uuid NOT NULL,
	"username" text NOT NULL,
	"vault_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rejected_at" timestamp with time zone,
	CONSTRAINT "ats_credentials_user_ats_company_key" UNIQUE("user_id","ats","company_id")
);
--> statement-breakpoint
CREATE TABLE "captcha_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"stage" "captcha_stage" DEFAULT 'agent1' NOT NULL,
	"attempts" jsonb DEFAULT '{"agent1":0,"agent2":0,"human":0}'::jsonb NOT NULL,
	"image_ref" text,
	"token_hash" text,
	"expires_at" timestamp with time zone,
	"human_answer" text,
	"resolved_by" "captcha_stage",
	"resolved_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"ats" "ats_kind",
	"board_slug" text,
	"board_url" text,
	"resolved_at" timestamp with time zone,
	"unresolved_until" timestamp with time zone,
	"created_by" "company_source" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid,
	"ats" "ats_kind",
	"ats_job_id" text,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"description" text,
	"location" text,
	"location_mode" text,
	"pay_min" integer,
	"pay_max" integer,
	"currency" text,
	"posted_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_tenant_url_key" UNIQUE("tenant_id","url"),
	CONSTRAINT "jobs_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "run_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"company_name" text NOT NULL,
	"url" text NOT NULL,
	"ats" "ats_kind",
	"ats_job_id" text,
	"judgment" jsonb,
	"prompt_version" text,
	"model" text,
	"rank" integer,
	"selected" boolean DEFAULT false NOT NULL,
	"exclusion_reason" text
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"trigger" "run_trigger" DEFAULT 'scheduled' NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"step" text,
	"target_n" integer NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"source_status" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"short_day" boolean DEFAULT false NOT NULL,
	"shortfall" integer DEFAULT 0 NOT NULL,
	"error" text,
	CONSTRAINT "runs_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "user_companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"source" "company_source" NOT NULL,
	"reason" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "user_companies_user_id_company_id_key" UNIQUE("user_id","company_id")
);
--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_tenant_id_job_id_jobs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","job_id") REFERENCES "public"."jobs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_credentials" ADD CONSTRAINT "ats_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_credentials" ADD CONSTRAINT "ats_credentials_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ats_credentials" ADD CONSTRAINT "ats_credentials_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captcha_requests" ADD CONSTRAINT "captcha_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captcha_requests" ADD CONSTRAINT "captcha_requests_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "captcha_requests" ADD CONSTRAINT "captcha_requests_tenant_id_application_id_applications_tenant_id_id_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_candidates" ADD CONSTRAINT "run_candidates_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_candidates" ADD CONSTRAINT "run_candidates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "applications_tenant_user_status_idx" ON "applications" USING btree ("tenant_id","user_id","status");--> statement-breakpoint
CREATE INDEX "ats_credentials_tenant_user_idx" ON "ats_credentials" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "captcha_requests_tenant_application_idx" ON "captcha_requests" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE INDEX "captcha_requests_tenant_user_stage_idx" ON "captcha_requests" USING btree ("tenant_id","user_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "captcha_requests_token_hash_key" ON "captcha_requests" USING btree ("token_hash") WHERE "captcha_requests"."token_hash" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_ats_board_slug_key" ON "companies" USING btree ("ats","board_slug") WHERE "companies"."ats" is not null;--> statement-breakpoint
CREATE INDEX "companies_name_idx" ON "companies" USING btree ("name");--> statement-breakpoint
CREATE INDEX "jobs_tenant_idx" ON "jobs" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_tenant_ats_job_id_key" ON "jobs" USING btree ("tenant_id","ats","ats_job_id") WHERE "jobs"."ats_job_id" is not null;--> statement-breakpoint
CREATE INDEX "run_candidates_tenant_run_idx" ON "run_candidates" USING btree ("tenant_id","run_id","rank");--> statement-breakpoint
CREATE INDEX "runs_tenant_user_date_idx" ON "runs" USING btree ("tenant_id","user_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_user_date_not_failed_key" ON "runs" USING btree ("user_id","date") WHERE "runs"."status" <> 'failed';--> statement-breakpoint
CREATE INDEX "user_companies_tenant_user_idx" ON "user_companies" USING btree ("tenant_id","user_id");--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE no action ON UPDATE no action;