-- Packages, memberships and gift cards; client records; commissions and cash closings;
-- verified reviews; calendar (iCal) feeds.
ALTER TYPE "payment_method" ADD VALUE IF NOT EXISTS 'gift_card';--> statement-breakpoint

-- Catalog: packages (N sessions, valid D days) and memberships (monthly, unlimited or capped)
CREATE TABLE IF NOT EXISTS "offerings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "price_cents" integer NOT NULL,
  "sessions" integer,
  "validity_days" integer,
  "service_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "offerings_kind" CHECK ("kind" IN ('package', 'membership')),
  CONSTRAINT "offerings_price" CHECK ("price_cents" >= 0)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "offerings_tenant_idx" ON "offerings" ("tenant_id");--> statement-breakpoint

-- Packages and memberships sold to a customer
CREATE TABLE IF NOT EXISTS "customer_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "offering_id" uuid REFERENCES "offerings"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "name" text NOT NULL,
  "service_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "sessions_total" integer,
  "price_cents" integer NOT NULL,
  "starts_on" date NOT NULL,
  "expires_on" date,
  "cancelled_at" timestamp with time zone,
  "location_id" uuid REFERENCES "locations"("id") ON DELETE SET NULL,
  "sold_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_plans_customer_idx" ON "customer_plans" ("tenant_id", "customer_id");--> statement-breakpoint

-- One session taken from a plan by a completed booking
CREATE TABLE IF NOT EXISTS "plan_uses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "customer_plan_id" uuid NOT NULL REFERENCES "customer_plans"("id") ON DELETE CASCADE,
  "appointment_id" uuid NOT NULL REFERENCES "appointments"("id") ON DELETE CASCADE,
  "sessions" integer DEFAULT 1 NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plan_uses_appointment_idx" ON "plan_uses" ("appointment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_uses_plan_idx" ON "plan_uses" ("customer_plan_id");--> statement-breakpoint

-- Gift cards: a peso balance with a unique code
CREATE TABLE IF NOT EXISTS "gift_cards" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "code" text NOT NULL,
  "initial_cents" integer NOT NULL,
  "balance_cents" integer NOT NULL,
  "customer_id" uuid REFERENCES "customers"("id") ON DELETE SET NULL,
  "recipient_name" text,
  "expires_on" date,
  "location_id" uuid REFERENCES "locations"("id") ON DELETE SET NULL,
  "sold_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "gift_cards_balance" CHECK ("balance_cents" >= 0 AND "balance_cents" <= "initial_cents")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gift_cards_tenant_code_idx" ON "gift_cards" ("tenant_id", "code");--> statement-breakpoint

-- Payments: what a sale paid for, where it was taken, and the gift card used to pay
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "location_id" uuid REFERENCES "locations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "customer_plan_id" uuid REFERENCES "customer_plans"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "sold_gift_card_id" uuid REFERENCES "gift_cards"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "gift_card_id" uuid REFERENCES "gift_cards"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Client record (encrypted fields) and consent
CREATE TABLE IF NOT EXISTS "customer_records" (
  "customer_id" uuid PRIMARY KEY NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "allergies_enc" text,
  "conditions_enc" text,
  "consent_at" timestamp with time zone,
  "consent_by" uuid,
  "updated_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "record_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "appointment_id" uuid REFERENCES "appointments"("id") ON DELETE SET NULL,
  "body_enc" text NOT NULL,
  "author_id" uuid,
  "author_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "record_notes_customer_idx" ON "record_notes" ("tenant_id", "customer_id", "created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "record_photos" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "appointment_id" uuid REFERENCES "appointments"("id") ON DELETE SET NULL,
  "kind" text NOT NULL,
  "note_enc" text,
  "blob_path" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "content_type" text NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "record_photos_kind" CHECK ("kind" IN ('before', 'after', 'other'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "record_photos_customer_idx" ON "record_photos" ("tenant_id", "customer_id");--> statement-breakpoint

-- Commissions: a general percent per team member, optionally replaced per service
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "commission_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "commission_by_service" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint

-- Cash closings (corte de caja)
CREATE TABLE IF NOT EXISTS "cash_closings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "location_id" uuid NOT NULL REFERENCES "locations"("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  "by_method" jsonb NOT NULL,
  "sales_cents" integer DEFAULT 0 NOT NULL,
  "expected_cash_cents" integer NOT NULL,
  "counted_cash_cents" integer NOT NULL,
  "notes" text,
  "closed_by" uuid,
  "closed_by_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cash_closings_tenant_day_idx" ON "cash_closings" ("tenant_id", "day");--> statement-breakpoint

-- Verified reviews: one per completed booking
CREATE TABLE IF NOT EXISTS "reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "appointment_id" uuid NOT NULL REFERENCES "appointments"("id") ON DELETE CASCADE,
  "customer_id" uuid REFERENCES "customers"("id") ON DELETE SET NULL,
  "location_id" uuid REFERENCES "locations"("id") ON DELETE SET NULL,
  "author_name" text NOT NULL,
  "rating" integer NOT NULL,
  "comment" text,
  "reply" text,
  "replied_at" timestamp with time zone,
  "hidden" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reviews_rating" CHECK ("rating" BETWEEN 1 AND 5)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reviews_appointment_idx" ON "reviews" ("appointment_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviews_tenant_idx" ON "reviews" ("tenant_id", "created_at");--> statement-breakpoint

-- Secret calendar subscription links (iCal)
CREATE TABLE IF NOT EXISTS "calendar_feeds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "token" text NOT NULL,
  "scope" text NOT NULL,
  "location_id" uuid REFERENCES "locations"("id") ON DELETE CASCADE,
  "resource_id" uuid REFERENCES "resources"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "calendar_feeds_scope" CHECK ("scope" IN ('business', 'location', 'resource'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_feeds_token_idx" ON "calendar_feeds" ("token");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "calendar_feeds_target_idx" ON "calendar_feeds" ("tenant_id", "scope", coalesce("location_id", '00000000-0000-0000-0000-000000000000'::uuid), coalesce("resource_id", '00000000-0000-0000-0000-000000000000'::uuid));
