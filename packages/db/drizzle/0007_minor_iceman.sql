CREATE TYPE "public"."credential_status" AS ENUM('registering', 'verified', 'rejected');--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "follow_up_enqueued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ats_credentials" ADD COLUMN "status" "credential_status" DEFAULT 'registering' NOT NULL;--> statement-breakpoint
ALTER TABLE "ats_credentials" ADD COLUMN "registration_started_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "ats_credentials" SET "status" = 'rejected' WHERE "rejected_at" IS NOT NULL;--> statement-breakpoint
-- Follow-up reconciliation for the worker (application role, no tenant context): identifiers and
-- the applied time only, like the other pre-tenant lookups.
CREATE FUNCTION wma_followups_owed(p_limit integer)
RETURNS TABLE (tenant_id uuid, user_id uuid, application_id uuid, applied_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT a.tenant_id, a.user_id, a.id, a.applied_at FROM public.applications a WHERE a.status = 'applied' AND a.follow_up_enqueued_at IS NULL AND a.applied_at IS NOT NULL ORDER BY a.applied_at LIMIT p_limit $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION wma_followups_owed(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION wma_followups_owed(integer) TO wma_app;
