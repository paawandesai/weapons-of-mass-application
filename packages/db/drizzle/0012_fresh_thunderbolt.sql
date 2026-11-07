CREATE TABLE "demo_calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"summary" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_calendar_tenant_client_key" UNIQUE("tenant_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "demo_mailbox_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"thread_id" text NOT NULL,
	"gmail_message_id" text NOT NULL,
	"history_id" bigint NOT NULL,
	"from_address" text NOT NULL,
	"from_name" text,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"label_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"internal_date" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_mailbox_tenant_message_key" UNIQUE("tenant_id","gmail_message_id"),
	CONSTRAINT "demo_mailbox_tenant_history_key" UNIQUE("tenant_id","history_id")
);
--> statement-breakpoint
CREATE TABLE "stage_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"from_status" "application_status" NOT NULL,
	"to_status" "application_status" NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "negotiation" jsonb;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "seeded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "demo_calendar_events" ADD CONSTRAINT "demo_calendar_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_calendar_events" ADD CONSTRAINT "demo_calendar_events_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_mailbox_messages" ADD CONSTRAINT "demo_mailbox_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "demo_mailbox_messages" ADD CONSTRAINT "demo_mailbox_messages_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_overrides" ADD CONSTRAINT "stage_overrides_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_overrides" ADD CONSTRAINT "stage_overrides_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stage_overrides" ADD CONSTRAINT "stage_overrides_tenant_id_application_id_applications_tenant_id_id_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demo_calendar_tenant_user_starts_idx" ON "demo_calendar_events" USING btree ("tenant_id","user_id","starts_at");--> statement-breakpoint
CREATE INDEX "demo_mailbox_tenant_thread_idx" ON "demo_mailbox_messages" USING btree ("tenant_id","thread_id","internal_date");--> statement-breakpoint
CREATE INDEX "stage_overrides_tenant_application_idx" ON "stage_overrides" USING btree ("tenant_id","application_id","at");