CREATE TYPE "public"."dispatch_state" AS ENUM('queued', 'dispatched', 'failed');--> statement-breakpoint
ALTER TABLE "activity_log" DROP CONSTRAINT "activity_log_application_id_applications_id_fk";
--> statement-breakpoint
ALTER TABLE "applications" DROP CONSTRAINT "applications_run_id_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "run_candidates" DROP CONSTRAINT "run_candidates_run_id_runs_id_fk";
--> statement-breakpoint
DROP INDEX "companies_ats_board_slug_key";--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "pay_min" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "pay_max" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "board_region" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "dispatch_state" "dispatch_state";--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_tenant_id_application_id_applications_tenant_id_id_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "applications" ADD CONSTRAINT "applications_tenant_id_run_id_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."runs"("tenant_id","id") ON DELETE SET NULL ("run_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_candidates" ADD CONSTRAINT "run_candidates_tenant_id_run_id_runs_tenant_id_id_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."runs"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_unresolved_name_key" ON "companies" USING btree (lower("name")) WHERE "companies"."ats" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "companies_ats_board_slug_key" ON "companies" USING btree ("ats","board_slug","board_region") WHERE "companies"."ats" is not null;--> statement-breakpoint
-- Scheduler enumeration for the worker (application role, no tenant context). Like the other
-- pre-tenant lookups these return identifiers and an hour only, never profile or contact data.
CREATE FUNCTION wma_run_roster()
RETURNS TABLE (tenant_id uuid, user_id uuid, run_hour integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT u.tenant_id, u.id, u.digest_hour FROM public.users u WHERE u.approved_profile_version IS NOT NULL $$;--> statement-breakpoint
CREATE FUNCTION wma_stale_runs(p_cutoff date)
RETURNS TABLE (tenant_id uuid, run_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT r.tenant_id, r.id FROM public.runs r WHERE r.date < p_cutoff $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wma_run_roster() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION wma_stale_runs(date) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION wma_run_roster() TO wma_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION wma_stale_runs(date) TO wma_app;
