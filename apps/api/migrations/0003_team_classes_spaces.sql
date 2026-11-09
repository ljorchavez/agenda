ALTER TYPE "business_type" ADD VALUE IF NOT EXISTS 'fitness' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "business_type" ADD VALUE IF NOT EXISTS 'yoga' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "business_type" ADD VALUE IF NOT EXISTS 'dance' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "business_type" ADD VALUE IF NOT EXISTS 'sports' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "business_type" ADD VALUE IF NOT EXISTS 'coworking' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "business_type" ADD VALUE IF NOT EXISTS 'studio' BEFORE 'other';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "professionals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#0f766e' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"service_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "professionals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "professionals_tenant_idx" ON "professionals" USING btree ("tenant_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_per_hour_cents" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spaces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "spaces_tenant_idx" ON "spaces" USING btree ("tenant_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "class_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"professional_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"capacity" integer NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "class_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade,
	CONSTRAINT "class_sessions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict,
	CONSTRAINT "class_sessions_professional_id_professionals_id_fk" FOREIGN KEY ("professional_id") REFERENCES "public"."professionals"("id") ON DELETE set null
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "class_sessions_tenant_starts_idx" ON "class_sessions" USING btree ("tenant_id","starts_at");--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "professional_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "space_id" uuid;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "class_session_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appointments" ADD CONSTRAINT "appointments_professional_id_professionals_id_fk" FOREIGN KEY ("professional_id") REFERENCES "public"."professionals"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appointments" ADD CONSTRAINT "appointments_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appointments" ADD CONSTRAINT "appointments_class_session_id_class_sessions_id_fk" FOREIGN KEY ("class_session_id") REFERENCES "public"."class_sessions"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_professional_starts_idx" ON "appointments" USING btree ("professional_id","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_space_starts_idx" ON "appointments" USING btree ("space_id","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_class_session_idx" ON "appointments" USING btree ("class_session_id");
