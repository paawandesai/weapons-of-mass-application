CREATE TYPE "public"."build_state" AS ENUM('running', 'done', 'failed');--> statement-breakpoint
CREATE TABLE "profile_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"state" "build_state" DEFAULT 'running' NOT NULL,
	"version" integer,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "approved_profile_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile_builds" ADD CONSTRAINT "profile_builds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_builds" ADD CONSTRAINT "profile_builds_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_builds_tenant_user_idx" ON "profile_builds" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON profile_builds TO wma_app;--> statement-breakpoint
ALTER TABLE profile_builds ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE profile_builds FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_select ON profile_builds FOR SELECT USING (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY tenant_insert ON profile_builds FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY tenant_update ON profile_builds FOR UPDATE USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY tenant_delete ON profile_builds FOR DELETE USING (tenant_id = current_setting('app.tenant_id')::uuid);
