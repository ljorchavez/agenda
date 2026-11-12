# Billing model

Each business (tenant) has its own plan (`tenants.plan`). Limits and prices live only in
`packages/shared` (`PLAN_LIMITS`, `ADDON_PRICES`) and are enforced in `apps/api/src/lib/plan.ts`.

| Plan     | Price (provisional) | Customers | Bookings / month | Locations | Other businesses |
|----------|---------------------|-----------|------------------|-----------|------------------|
| Gratis   | $0                  | 5         | no limit         | 1         | no               |
| Estándar | $399 / month        | no limit  | 500              | 1 + extras| yes (each extra) |
| Premium  | to be defined       | no limit  | no limit         | 1 + extras| yes              |

Features by plan (`PLAN_LIMITS.packages | records | cash | recordPhotosMb`):

| Feature | Gratis | Individual | Estándar | Premium |
|---|---|---|---|---|
| Verified reviews, iCal calendar links | ✓ | ✓ | ✓ | ✓ |
| Packages, memberships, gift cards | – | ✓ | ✓ | ✓ |
| Client record (encrypted) + questionnaires per booking type | – | ✓ (1 GB photos) | ✓ (1 GB photos) | ✓ (10 GB photos) |
| Commissions and cash closing | – | ✓ | ✓ | ✓ |
| Agendas (people/spaces) | ∞ | 1 | ∞ | ∞ |
| Locations included | 1 | 1 | 1 (+extras) | 2 (+extras) |
| Price / month (+ IVA) | $0 | $249 | $399 | $799 |

Missing feature → **402** `plan_limit_packages | plan_limit_records | plan_limit_cash`; Individual over one agenda → `plan_limit_resources`; photo
storage full → `plan_limit_photos`.

Add-ons: extra active location $199 / month, extra business $299 / month (includes Estándar).
Over a limit the API answers **402** with `plan_limit_customers | plan_limit_bookings |
plan_limit_locations | plan_limit_businesses`. Logins (admins, gerentes, colaboradores) are free.

- Sign-up (`/registro`) starts with the plan cards, then the account form (`plan` in `/auth/register`).
- Settings → Plan y uso: current plan, usage, monthly total and plan change (`GET/PUT /api/tenant/plan`, owner only).
- Demo businesses are seeded on Premium so their history doesn't hit limits.

## Card billing (Mercado Pago Suscripciones)

`apps/api/src/lib/billing.ts`. Each business pays its plan monthly with a card to Lugali's own
Mercado Pago account (preapproval without a plan, amount with IVA = `withIva`).

Env (Vercel, production): `MERCADOPAGO_BILLING_ACCESS_TOKEN` (Lugali's account, separate from the
businesses' tokens) and `MERCADOPAGO_BILLING_WEBHOOK_SECRET`. Webhook in the Mercado Pago app:
`https://lugali.com/api/webhooks/billing`, events "Planes y suscripciones" (subscription_preapproval,
subscription_authorized_payment). Without the token everything works as before (no charge).

- `PUT /api/tenant/plan`
  - to Gratis: cancels the subscription, plan changes now;
  - paid → paid with a live subscription: new amount from the next charge (no proration);
  - otherwise: creates a subscription (`billing_status = pending`, `billing_pending_plan`) and
    returns Mercado Pago's `checkoutUrl`; the plan changes when the webhook says `authorized`.
- Sign-up on a paid plan opens the business on Gratis and sends the owner to pay right away.
- An extra business opened while billing is on is read-only until its subscription is paid.
- A rejected monthly charge → `past_due`; after `BILLING_GRACE_DAYS` (7) the business is
  read-only (`402 billing_read_only` on any change except plan, sign-in, export and delete).
  Mercado Pago retries; an approved charge clears it. Cancelled at Mercado Pago → plan Gratis.
- Adding/removing locations updates the monthly amount (`syncBillingAmount`).
- The daily cron (`/api/cron/reset-demo`) re-reads every subscription (`reconcileBilling`).
- Demo businesses (`*-demo`) are never charged.

Fees (nov 2026): Mercado Pago Suscripciones 3.19% + IVA (money at once) or 2.89% + IVA (10 days);
no monthly fee. Stripe was left out (3.6% + $3 MXN + 0.7% Billing).
