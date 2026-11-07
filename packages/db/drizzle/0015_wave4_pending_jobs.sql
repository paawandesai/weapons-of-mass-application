CREATE TABLE "pending_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	CONSTRAINT "pending_jobs_tenant_dedupe_key" UNIQUE("tenant_id","dedupe_key")
);
--> statement-breakpoint
ALTER TABLE "email_threads" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "pending_jobs" ADD CONSTRAINT "pending_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_jobs" ADD CONSTRAINT "pending_jobs_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_jobs_undispatched_idx" ON "pending_jobs" USING btree ("tenant_id","dispatched_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "pending_jobs" TO wma_app;--> statement-breakpoint
ALTER TABLE "pending_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pending_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_select ON "pending_jobs" FOR SELECT USING (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY tenant_insert ON "pending_jobs" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY tenant_update ON "pending_jobs" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY tenant_delete ON "pending_jobs" FOR DELETE USING (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
-- Tenants that have undispatched work, so the reconciler can open one tenant handle per tenant.
-- Returns ids only; the rows themselves are read under the tenant's own RLS.
CREATE FUNCTION wma_pending_job_tenants()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT DISTINCT p.tenant_id FROM public.pending_jobs p WHERE p.dispatched_at IS NULL $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wma_pending_job_tenants() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION wma_pending_job_tenants() TO wma_app;
