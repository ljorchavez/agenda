CREATE TABLE IF NOT EXISTS "ai_usage" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "day" date NOT NULL,
  "feature" text NOT NULL,
  "calls" integer NOT NULL DEFAULT 0,
  "input_tokens" integer NOT NULL DEFAULT 0,
  "output_tokens" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("tenant_id", "day", "feature")
);
