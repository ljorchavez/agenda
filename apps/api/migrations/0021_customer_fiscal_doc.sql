-- The customer's Constancia de Situación Fiscal: where the private file is and what it is.
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "fiscal_doc" jsonb;
