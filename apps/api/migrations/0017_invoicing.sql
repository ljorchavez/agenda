-- Electronic invoicing (CFDI) with Facturapi: each business's issuer keys (encrypted), customers'
-- fiscal data and the invoices issued.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "invoicing_enc" text;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "fiscal" jsonb;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "payment_id" uuid REFERENCES "payments"("id") ON DELETE SET NULL,
  "customer_id" uuid REFERENCES "customers"("id") ON DELETE SET NULL,
  "facturapi_id" text NOT NULL,
  "uuid" text,
  "series" text,
  "folio" integer,
  "total_cents" integer NOT NULL,
  "status" text DEFAULT 'valid' NOT NULL,
  "test" boolean DEFAULT false NOT NULL,
  "receiver_rfc" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "canceled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_tenant_idx" ON "invoices" ("tenant_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoices_payment_idx" ON "invoices" ("payment_id");
