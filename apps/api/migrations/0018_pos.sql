-- Light point of sale: products with stock per location, counter sales (several lines, split
-- payments) and the stock movements behind them.
CREATE TABLE IF NOT EXISTS "products" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "sku" text,
  "category" text,
  "price_cents" integer NOT NULL,
  "cost_cents" integer,
  "track_stock" boolean DEFAULT true NOT NULL,
  "min_stock" integer,
  "iva" text DEFAULT '16' NOT NULL,
  "sat_key" text,
  "requires_prescription" boolean DEFAULT false NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_tenant_idx" ON "products" ("tenant_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_stock" (
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "location_id" uuid NOT NULL REFERENCES "locations"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "qty" integer DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("product_id", "location_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sales" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "location_id" uuid NOT NULL REFERENCES "locations"("id") ON DELETE CASCADE,
  "number" integer NOT NULL,
  "customer_id" uuid REFERENCES "customers"("id") ON DELETE SET NULL,
  "items" jsonb NOT NULL,
  "total_cents" integer NOT NULL,
  "status" text DEFAULT 'paid' NOT NULL,
  "notes" text,
  "created_by" uuid,
  "created_by_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "canceled_at" timestamp with time zone,
  "canceled_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_tenant_number_idx" ON "sales" ("tenant_id", "number");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sales_tenant_created_idx" ON "sales" ("tenant_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stock_moves" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "location_id" uuid NOT NULL REFERENCES "locations"("id") ON DELETE CASCADE,
  "qty_change" integer NOT NULL,
  "qty_after" integer NOT NULL,
  "reason" text NOT NULL,
  "sale_id" uuid REFERENCES "sales"("id") ON DELETE SET NULL,
  "note" text,
  "created_by" uuid,
  "created_by_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stock_moves_product_idx" ON "stock_moves" ("product_id", "created_at");
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "sale_id" uuid REFERENCES "sales"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payments_sale_idx" ON "payments" ("sale_id");
