CREATE TYPE "public"."outreach_state" AS ENUM('draft', 'approved', 'sending', 'sent', 'rejected', 'failed');--> statement-breakpoint
ALTER TYPE "public"."outgoing_kind" ADD VALUE 'outreach' BEFORE 'other';--> statement-breakpoint
CREATE TABLE "outreach_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"contact_name" text NOT NULL,
	"contact_title" text,
	"contact_profile_url" text,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"linkedin_note" text,
	"state" "outreach_state" DEFAULT 'draft' NOT NULL,
	"approved_hash" text,
	"approved_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"outgoing_id" uuid,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ADD CONSTRAINT "outreach_drafts_tenant_id_application_id_applications_tenant_id_id_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outreach_drafts_tenant_user_state_idx" ON "outreach_drafts" USING btree ("tenant_id","user_id","state");--> statement-breakpoint
CREATE INDEX "outreach_drafts_tenant_application_idx" ON "outreach_drafts" USING btree ("tenant_id","application_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "outreach_drafts" TO wma_app;--> statement-breakpoint
ALTER TABLE "outreach_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outreach_drafts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_select ON "outreach_drafts" FOR SELECT USING (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY tenant_insert ON "outreach_drafts" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY tenant_update ON "outreach_drafts" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY tenant_delete ON "outreach_drafts" FOR DELETE USING (tenant_id = current_setting('app.tenant_id')::uuid);
