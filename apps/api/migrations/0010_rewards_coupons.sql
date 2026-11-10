-- Discounts: loyalty rewards (every N visits) and coupon codes.
CREATE TABLE IF NOT EXISTS "coupons" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "code" text NOT NULL,
  "discount_type" text NOT NULL,
  "value" integer NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "max_uses" integer,
  "valid_until" date,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "coupons_type" CHECK ("discount_type" IN ('percent', 'amount')),
  CONSTRAINT "coupons_value" CHECK ("value" > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "coupons_tenant_code_idx" ON "coupons" ("tenant_id", upper("code"));--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "discount_reason" text;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "coupon_id" uuid REFERENCES "coupons"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_coupon_idx" ON "appointments" ("coupon_id");
