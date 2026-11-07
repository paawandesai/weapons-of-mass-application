CREATE TYPE "public"."secret_kind" AS ENUM('google_refresh_token', 'ats_password');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('resume', 'linkedin', 'github', 'drive', 'gmail', 'calendar');--> statement-breakpoint
CREATE TYPE "public"."source_status" AS ENUM('connected', 'disconnected', 'partial');--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"application_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"document" jsonb NOT NULL,
	"built_from" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_user_id_version_key" UNIQUE("user_id","version")
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "secret_kind" NOT NULL,
	"ref" varchar(200) NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"iv" "bytea" NOT NULL,
	"tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "source_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "source_kind" NOT NULL,
	"status" "source_status" DEFAULT 'connected' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"file_ref" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"google_sub" text NOT NULL,
	"display_name" text,
	"approved_profile_version" integer,
	"digest_hour" integer DEFAULT 8 NOT NULL,
	"daily_target" integer DEFAULT 12 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub"),
	CONSTRAINT "users_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "vault_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"wrap_iv" "bytea" NOT NULL,
	"wrap_tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_connections" ADD CONSTRAINT "source_connections_tenant_id_user_id_users_tenant_id_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."users"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_keys" ADD CONSTRAINT "vault_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_tenant_user_at_idx" ON "activity_log" USING btree ("tenant_id","user_id","at");--> statement-breakpoint
CREATE INDEX "activity_log_tenant_application_at_idx" ON "activity_log" USING btree ("tenant_id","application_id","at");--> statement-breakpoint
CREATE INDEX "profiles_tenant_user_idx" ON "profiles" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_tenant_kind_ref_key" ON "secrets" USING btree ("tenant_id","kind","ref");--> statement-breakpoint
CREATE INDEX "sessions_tenant_user_idx" ON "sessions" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "source_connections_tenant_user_idx" ON "source_connections" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_keys_tenant_id_key" ON "vault_keys" USING btree ("tenant_id");