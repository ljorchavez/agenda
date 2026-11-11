-- Coupons: valid for some services only (empty = all) and a limit per customer (null = no limit).
ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "service_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "coupons" ADD COLUMN IF NOT EXISTS "max_uses_per_customer" integer;
