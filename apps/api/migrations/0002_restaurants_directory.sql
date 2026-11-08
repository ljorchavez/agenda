ALTER TYPE "business_type" ADD VALUE IF NOT EXISTS 'spa' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "business_type" ADD VALUE IF NOT EXISTS 'veterinary' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "business_type" ADD VALUE IF NOT EXISTS 'restaurant' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "business_type" ADD VALUE IF NOT EXISTS 'cafe' BEFORE 'other';--> statement-breakpoint
ALTER TYPE "business_type" ADD VALUE IF NOT EXISTS 'bar' BEFORE 'other';--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "description" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "address" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "neighborhood" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "city" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "state" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "lat" double precision;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "lng" double precision;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "directory_listed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tenants_directory_idx" ON "tenants" USING btree ("directory_listed","business_type");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dining_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"seats" integer NOT NULL,
	"area" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dining_tables_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dining_tables_tenant_idx" ON "dining_tables" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "party_size" integer;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "table_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "appointments" ADD CONSTRAINT "appointments_table_id_dining_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."dining_tables"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_table_starts_idx" ON "appointments" USING btree ("table_id","starts_at");
