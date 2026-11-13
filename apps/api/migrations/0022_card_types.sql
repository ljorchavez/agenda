ALTER TYPE "payment_method" ADD VALUE IF NOT EXISTS 'credit_card' AFTER 'card';--> statement-breakpoint
ALTER TYPE "payment_method" ADD VALUE IF NOT EXISTS 'debit_card' AFTER 'credit_card';
