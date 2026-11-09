-- Password reset links and login throttling.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_changed_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "password_resets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "password_resets_token_idx" ON "password_resets" ("token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "password_resets_user_idx" ON "password_resets" ("user_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "auth_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_attempts_key_idx" ON "auth_attempts" ("key", "created_at");
