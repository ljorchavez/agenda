-- Own working hours per resource, photos, a rating per booking and blocked times.
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "hours" jsonb;--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "photo_url" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "photo_url" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "rating" smallint;--> statement-breakpoint
ALTER TABLE "appointments" DROP CONSTRAINT IF EXISTS "appointments_rating_range";--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_rating_range" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "time_blocks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "location_id" uuid REFERENCES "locations"("id") ON DELETE CASCADE,
  "resource_id" uuid REFERENCES "resources"("id") ON DELETE CASCADE,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "time_blocks_range" CHECK ("ends_at" > "starts_at")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "time_blocks_tenant_idx" ON "time_blocks" ("tenant_id", "starts_at");
