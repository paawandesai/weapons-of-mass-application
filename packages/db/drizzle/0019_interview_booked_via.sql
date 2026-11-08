ALTER TABLE "interviews" ALTER COLUMN "thread_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN IF NOT EXISTS "booked_via" text;