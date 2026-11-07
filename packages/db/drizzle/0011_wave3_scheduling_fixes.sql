CREATE TABLE "digest_state" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"collected_through" timestamp with time zone NOT NULL,
	CONSTRAINT "digest_state_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "confirmed_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "calendar_event_client_id" text;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "booked_generation" integer;--> statement-breakpoint
ALTER TABLE "digest_state" ADD CONSTRAINT "digest_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_state" ADD CONSTRAINT "digest_state_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Existing confirmed interviews count as generation 1 (their reply and event are tracked by the old markers).
UPDATE "interviews" SET "confirmed_generation" = 1, "booked_generation" = CASE WHEN "reply_sent_at" IS NOT NULL AND "calendar_event_id" IS NOT NULL THEN 1 ELSE NULL END WHERE "confirmed_slot_id" IS NOT NULL;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "digest_state" TO wma_app;--> statement-breakpoint
ALTER TABLE "digest_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "digest_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_select ON "digest_state" FOR SELECT USING (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY tenant_insert ON "digest_state" FOR INSERT WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY tenant_update ON "digest_state" FOR UPDATE USING (tenant_id = current_setting('app.tenant_id')::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);--> statement-breakpoint
CREATE POLICY tenant_delete ON "digest_state" FOR DELETE USING (tenant_id = current_setting('app.tenant_id')::uuid);
