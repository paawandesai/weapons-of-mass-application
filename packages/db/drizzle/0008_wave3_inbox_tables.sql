CREATE TYPE "public"."outgoing_kind" AS ENUM('follow_up', 'slot_confirmation', 'recruiter_reply', 'reminder', 'digest', 'captcha_request', 'other');--> statement-breakpoint
CREATE TYPE "public"."prep_plan_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."processed_outcome" AS ENUM('linked', 'unlinked', 'failed');--> statement-breakpoint
CREATE TYPE "public"."thread_kind" AS ENUM('confirmation', 'rejection', 'interview', 'offer', 'other', 'unlinked');--> statement-breakpoint
CREATE TABLE "email_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid,
	"gmail_thread_id" text NOT NULL,
	"kind" "thread_kind" NOT NULL,
	"compensation_flag" boolean DEFAULT false NOT NULL,
	"booking_link" text,
	"prompt_version" text,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_threads_tenant_gmail_thread_key" UNIQUE("tenant_id","gmail_thread_id"),
	CONSTRAINT "email_threads_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "interview_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"interview_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"tz_hint" text,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invalidated_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"confirmed_slot_id" uuid,
	"confirmed_at" timestamp with time zone,
	"calendar_event_id" text,
	"reply_sent_at" timestamp with time zone,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"prep_plan" text,
	"prep_plan_status" "prep_plan_status",
	"feedback" jsonb,
	"confirmation_email_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interviews_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "interviews_tenant_thread_key" UNIQUE("tenant_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "mail_sync_state" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"history_id" text,
	"last_synced_at" timestamp with time zone,
	"reauth_needed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "mail_sync_state_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "outgoing_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid,
	"kind" "outgoing_kind" NOT NULL,
	"to_address" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text,
	"gmail_message_id" text,
	"blocked" boolean DEFAULT false NOT NULL,
	"blocked_reason" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_messages" (
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"gmail_message_id" text NOT NULL,
	"thread_id" uuid,
	"outcome" "processed_outcome" NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_messages_tenant_id_gmail_message_id_pk" PRIMARY KEY("tenant_id","gmail_message_id")
);
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN "followed_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "timezone" text DEFAULT 'America/Los_Angeles' NOT NULL;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_threads" ADD CONSTRAINT "email_threads_tenant_id_application_id_applications_tenant_id_id_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_slots" ADD CONSTRAINT "interview_slots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_slots" ADD CONSTRAINT "interview_slots_tenant_id_interview_id_interviews_tenant_id_id_fk" FOREIGN KEY ("tenant_id","interview_id") REFERENCES "public"."interviews"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_tenant_id_application_id_applications_tenant_id_id_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interviews" ADD CONSTRAINT "interviews_tenant_id_thread_id_email_threads_tenant_id_id_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."email_threads"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_sync_state" ADD CONSTRAINT "mail_sync_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_sync_state" ADD CONSTRAINT "mail_sync_state_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD CONSTRAINT "outgoing_messages_tenant_id_application_id_applications_tenant_id_id_fk" FOREIGN KEY ("tenant_id","application_id") REFERENCES "public"."applications"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_messages" ADD CONSTRAINT "processed_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_messages" ADD CONSTRAINT "processed_messages_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processed_messages" ADD CONSTRAINT "processed_messages_tenant_id_thread_id_email_threads_tenant_id_id_fk" FOREIGN KEY ("tenant_id","thread_id") REFERENCES "public"."email_threads"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_threads_tenant_application_idx" ON "email_threads" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interview_slots_token_hash_key" ON "interview_slots" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "interview_slots_tenant_interview_idx" ON "interview_slots" USING btree ("tenant_id","interview_id");--> statement-breakpoint
CREATE INDEX "interviews_tenant_application_idx" ON "interviews" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE INDEX "interviews_tenant_user_starts_idx" ON "interviews" USING btree ("tenant_id","user_id","starts_at");--> statement-breakpoint
CREATE INDEX "outgoing_messages_tenant_user_created_idx" ON "outgoing_messages" USING btree ("tenant_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "outgoing_messages_tenant_application_idx" ON "outgoing_messages" USING btree ("tenant_id","application_id");--> statement-breakpoint
CREATE INDEX "processed_messages_tenant_user_idx" ON "processed_messages" USING btree ("tenant_id","user_id");