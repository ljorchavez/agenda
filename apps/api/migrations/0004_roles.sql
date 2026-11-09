ALTER TYPE "role" ADD VALUE IF NOT EXISTS 'admin' BEFORE 'staff';--> statement-breakpoint
UPDATE "professionals" p SET "user_id" = NULL
  WHERE "user_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = p."user_id" AND u."tenant_id" = p."tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "professionals_user_uq" ON "professionals" ("tenant_id", "user_id") WHERE "user_id" IS NOT NULL;
