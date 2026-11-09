-- Locations (sucursales): every business has a primary one; resources and bookings belong to a location.
CREATE TABLE IF NOT EXISTS "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"phone" text,
	"address" text,
	"neighborhood" text,
	"city" text,
	"state" text,
	"lat" double precision,
	"lng" double precision,
	"hours" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade,
	CONSTRAINT "locations_tenant_id_id_uq" UNIQUE ("tenant_id", "id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "locations_primary_uq" ON "locations" ("tenant_id") WHERE "is_primary";--> statement-breakpoint
INSERT INTO "locations" ("tenant_id", "name", "is_primary")
SELECT t."id", 'Principal', true FROM "tenants" t
WHERE NOT EXISTS (SELECT 1 FROM "locations" l WHERE l."tenant_id" = t."id" AND l."is_primary");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "create_primary_location"() RETURNS trigger AS $$
BEGIN
	INSERT INTO "locations" ("tenant_id", "name", "is_primary") VALUES (NEW."id", 'Principal', true);
	RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "tenants_primary_location" ON "tenants";--> statement-breakpoint
CREATE TRIGGER "tenants_primary_location" AFTER INSERT ON "tenants" FOR EACH ROW EXECUTE FUNCTION "create_primary_location"();--> statement-breakpoint
-- Rows inserted without a location go to the business's primary one.
CREATE OR REPLACE FUNCTION "set_default_location"() RETURNS trigger AS $$
BEGIN
	IF NEW."location_id" IS NULL THEN
		SELECT "id" INTO NEW."location_id" FROM "locations" WHERE "tenant_id" = NEW."tenant_id" AND "is_primary";
	END IF;
	RETURN NEW;
END $$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
	FOREACH t IN ARRAY ARRAY['professionals', 'dining_tables', 'spaces', 'class_sessions', 'appointments'] LOOP
		EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS "location_id" uuid', t);
		EXECUTE format('UPDATE %I x SET "location_id" = l."id" FROM "locations" l WHERE l."tenant_id" = x."tenant_id" AND l."is_primary" AND x."location_id" IS NULL', t);
		EXECUTE format('ALTER TABLE %I ALTER COLUMN "location_id" SET NOT NULL', t);
		-- Same-tenant guarantee at the database level
		EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id")', t, t || '_location_fk');
		EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I ("tenant_id", "location_id")', t || '_location_idx', t);
		EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_default_location', t);
		EXECUTE format('CREATE TRIGGER %I BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION "set_default_location"()', t || '_default_location', t);
	END LOOP;
END $$;--> statement-breakpoint
-- Memberships: one login can belong to several businesses, with a role (and optional location) in each.
CREATE TABLE IF NOT EXISTS "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role" DEFAULT 'staff' NOT NULL,
	"location_id" uuid,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade,
	CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade,
	CONSTRAINT "memberships_location_fk" FOREIGN KEY ("tenant_id", "location_id") REFERENCES "locations"("tenant_id", "id")
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_tenant_user_uq" ON "memberships" ("tenant_id", "user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_user_idx" ON "memberships" ("user_id");--> statement-breakpoint
INSERT INTO "memberships" ("tenant_id", "user_id", "role")
SELECT u."tenant_id", u."id", u."role" FROM "users" u
ON CONFLICT ("tenant_id", "user_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "role";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "tenant_id";
