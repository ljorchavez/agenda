ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "mp_access_token_enc" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "mp_account" text;
