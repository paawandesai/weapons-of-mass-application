CREATE TYPE "public"."outgoing_state" AS ENUM('pending', 'sent', 'blocked');--> statement-breakpoint
ALTER TABLE "mail_sync_state" ADD COLUMN "deferred_message_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "state" "outgoing_state" DEFAULT 'sent' NOT NULL;--> statement-breakpoint
ALTER TABLE "outgoing_messages" ADD COLUMN "delivery_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "outgoing_messages_tenant_delivery_key_key" ON "outgoing_messages" USING btree ("tenant_id","delivery_key") WHERE "outgoing_messages"."delivery_key" is not null;--> statement-breakpoint
UPDATE "outgoing_messages" SET "state" = 'blocked' WHERE "blocked" = true;--> statement-breakpoint
UPDATE "outgoing_messages" SET
  "body_text" = regexp_replace("body_text", '/confirm/[A-Za-z0-9_~.%-]+', '/confirm/[redacted]', 'g'),
  "body_html" = regexp_replace("body_html", '/confirm/[A-Za-z0-9_~.%-]+', '/confirm/[redacted]', 'g')
WHERE "body_text" LIKE '%/confirm/%' OR "body_html" LIKE '%/confirm/%';
