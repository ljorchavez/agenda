-- Clinical record for health businesses (NOM-004-SSA3-2012; dental NOM-013-SSA2-2015).
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "sex" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "address" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "curp" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "professional" jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clinical_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "appointment_id" uuid REFERENCES "appointments"("id") ON DELETE SET NULL,
  "template" text NOT NULL,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "content_enc" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "author_id" uuid,
  "author" jsonb,
  "signed_at" timestamp with time zone,
  "content_hash" text,
  "amends_id" uuid REFERENCES "clinical_notes"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clinical_notes_customer_idx" ON "clinical_notes" ("tenant_id", "customer_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "record_access_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "user_id" uuid,
  "user_name" text,
  "action" text NOT NULL,
  "detail" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "record_access_log_customer_idx" ON "record_access_log" ("tenant_id", "customer_id", "created_at");
