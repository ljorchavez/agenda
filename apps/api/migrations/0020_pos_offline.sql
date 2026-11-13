-- Point of sale without internet: the device names each sale (client_id) so a retry after a
-- cut never saves it twice, and sales uploaded later are marked.
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "client_id" text;
--> statement-breakpoint
ALTER TABLE "sales" ADD COLUMN IF NOT EXISTS "offline" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_tenant_client_idx" ON "sales" ("tenant_id", "client_id") WHERE "client_id" IS NOT NULL;
