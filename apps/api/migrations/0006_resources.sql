-- One concept for whatever gets booked: people (team, instructors), spaces (courts, rooms) and
-- restaurant tables become "resources". Ids are kept, so existing links stay valid.
CREATE TABLE IF NOT EXISTS "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#0f766e' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"service_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"user_id" uuid,
	"capacity" integer,
	"price_per_hour_cents" integer,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade,
	CONSTRAINT "resources_location_fk" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "resources_tenant_idx" ON "resources" ("tenant_id", "location_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "resources_user_uq" ON "resources" ("tenant_id", "user_id") WHERE "user_id" IS NOT NULL;--> statement-breakpoint
DROP TRIGGER IF EXISTS "resources_default_location" ON "resources";--> statement-breakpoint
CREATE TRIGGER "resources_default_location" BEFORE INSERT ON "resources" FOR EACH ROW EXECUTE FUNCTION "set_default_location"();--> statement-breakpoint
INSERT INTO "resources" ("id", "tenant_id", "location_id", "name", "color", "active", "service_ids", "user_id", "created_at", "updated_at")
SELECT "id", "tenant_id", "location_id", "name", "color", "active", "service_ids", "user_id", "created_at", "updated_at" FROM "professionals"
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- Spaces and tables get distinct colours from the palette (people keep theirs).
INSERT INTO "resources" ("id", "tenant_id", "location_id", "name", "color", "active", "price_per_hour_cents", "description", "created_at", "updated_at")
SELECT s."id", s."tenant_id", s."location_id", s."name",
	(ARRAY['#2563eb', '#16a34a', '#ea580c', '#7c3aed', '#db2777', '#ca8a04', '#0f766e', '#475569'])[1 + ((row_number() OVER (PARTITION BY s."tenant_id" ORDER BY s."name") - 1) % 8)::int],
	s."active", s."price_per_hour_cents", s."description", s."created_at", s."updated_at"
FROM "spaces" s
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "resources" ("id", "tenant_id", "location_id", "name", "color", "active", "capacity", "description", "created_at", "updated_at")
SELECT t."id", t."tenant_id", t."location_id", t."name",
	(ARRAY['#0f766e', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#ca8a04', '#16a34a', '#475569'])[1 + ((row_number() OVER (PARTITION BY t."tenant_id" ORDER BY t."name") - 1) % 8)::int],
	t."active", t."seats", t."area", t."created_at", t."updated_at"
FROM "dining_tables" t
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN IF NOT EXISTS "resource_id" uuid;--> statement-breakpoint
UPDATE "appointments" SET "resource_id" = COALESCE("professional_id", "space_id", "table_id") WHERE "resource_id" IS NULL;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE set null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_resource_starts_idx" ON "appointments" ("resource_id", "starts_at");--> statement-breakpoint
ALTER TABLE "class_sessions" ADD COLUMN IF NOT EXISTS "resource_id" uuid;--> statement-breakpoint
UPDATE "class_sessions" SET "resource_id" = "professional_id" WHERE "resource_id" IS NULL;--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "appointments" DROP COLUMN IF EXISTS "professional_id";--> statement-breakpoint
ALTER TABLE "appointments" DROP COLUMN IF EXISTS "space_id";--> statement-breakpoint
ALTER TABLE "appointments" DROP COLUMN IF EXISTS "table_id";--> statement-breakpoint
ALTER TABLE "class_sessions" DROP COLUMN IF EXISTS "professional_id";--> statement-breakpoint
DROP TABLE IF EXISTS "professionals";--> statement-breakpoint
DROP TABLE IF EXISTS "spaces";--> statement-breakpoint
DROP TABLE IF EXISTS "dining_tables";
