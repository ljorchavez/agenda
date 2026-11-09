-- Subscription plan per business. Businesses created before plans existed keep working as Estándar.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "plan" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
UPDATE "tenants" SET "plan" = 'standard';
