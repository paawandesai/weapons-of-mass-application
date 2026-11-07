CREATE TABLE "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"purpose" text NOT NULL,
	"prompt" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 8),
	"duration_ms" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_tenant_id_application_id_applications_tenant_id_id_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE SET NULL (application_id) ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_usage_tenant_user_at_idx" ON "llm_usage" USING btree ("tenant_id","user_id","at");--> statement-breakpoint
CREATE INDEX "llm_usage_tenant_application_idx" ON "llm_usage" USING btree ("tenant_id","application_id");--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "llm_usage" TO wma_app;--> statement-breakpoint
ALTER TABLE "llm_usage" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "llm_usage" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_select ON "llm_usage" FOR SELECT USING (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY tenant_insert ON "llm_usage" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY tenant_update ON "llm_usage" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY tenant_delete ON "llm_usage" FOR DELETE USING (tenant_id = current_setting('app.tenant_id')::uuid);
