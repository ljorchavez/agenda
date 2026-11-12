-- Launch hardening: two-step sign-in, subscription billing state and error monitoring.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_secret_enc" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_enabled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_last_step" bigint;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_recovery" jsonb;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "billing_status" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "billing_subscription_id" text;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "billing_pending_plan" text;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "billing_amount_cents" integer;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "billing_past_due_since" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "error_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "fingerprint" text NOT NULL,
  "source" text NOT NULL,
  "message" text NOT NULL,
  "stack" text,
  "path" text,
  "user_agent" text,
  "tenant_id" uuid,
  "count" integer DEFAULT 1 NOT NULL,
  "first_seen" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen" timestamp with time zone DEFAULT now() NOT NULL,
  "last_alerted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "error_events_fingerprint_idx" ON "error_events" ("fingerprint");
