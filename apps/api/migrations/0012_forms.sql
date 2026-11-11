-- Questionnaires per booking type: reusable forms attached to services; answers go to the client record.
CREATE TABLE IF NOT EXISTS "forms" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "service_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "ask_online" boolean DEFAULT true NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "forms_tenant_idx" ON "forms" ("tenant_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "form_responses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE CASCADE,
  "appointment_id" uuid REFERENCES "appointments"("id") ON DELETE SET NULL,
  "form_id" uuid REFERENCES "forms"("id") ON DELETE SET NULL,
  "form_name" text NOT NULL,
  "answers_enc" text NOT NULL,
  "source" text NOT NULL,
  "author_id" uuid,
  "author_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "form_responses_source" CHECK ("source" IN ('customer', 'staff'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_responses_customer_idx" ON "form_responses" ("tenant_id", "customer_id", "created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "form_responses_appt_form_idx" ON "form_responses" ("appointment_id", "form_id") WHERE "appointment_id" IS NOT NULL AND "form_id" IS NOT NULL;
