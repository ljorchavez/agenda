-- Online sales of packages, memberships and gift cards: what a pending payment buys.
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "purchase" jsonb;
