ALTER TABLE "interviews" ALTER COLUMN "thread_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "interviews" ADD COLUMN "booked_via" text;