ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "number" integer;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "number" integer;--> statement-breakpoint
UPDATE "products" p SET "number" = x.n FROM (SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS n FROM "products") x WHERE x.id = p.id AND p."number" IS NULL;--> statement-breakpoint
UPDATE "customers" c SET "number" = x.n FROM (SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS n FROM "customers" WHERE notes IS DISTINCT FROM '__venta_mostrador__') x WHERE x.id = c.id AND c."number" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "assign_tenant_number"() RETURNS trigger AS $$
BEGIN
  IF NEW."number" IS NULL AND NOT (TG_TABLE_NAME = 'customers' AND NEW.notes IS NOT DISTINCT FROM '__venta_mostrador__') THEN
    PERFORM pg_advisory_xact_lock(hashtext(TG_TABLE_NAME), hashtext(NEW.tenant_id::text));
    EXECUTE format('SELECT coalesce(max("number"), 0) + 1 FROM %I WHERE tenant_id = $1', TG_TABLE_NAME) INTO NEW."number" USING NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS "products_number" ON "products";--> statement-breakpoint
CREATE TRIGGER "products_number" BEFORE INSERT ON "products" FOR EACH ROW EXECUTE FUNCTION "assign_tenant_number"();--> statement-breakpoint
DROP TRIGGER IF EXISTS "customers_number" ON "customers";--> statement-breakpoint
CREATE TRIGGER "customers_number" BEFORE INSERT ON "customers" FOR EACH ROW EXECUTE FUNCTION "assign_tenant_number"();--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_tenant_number_idx" ON "products" ("tenant_id", "number");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customers_tenant_number_idx" ON "customers" ("tenant_id", "number");
