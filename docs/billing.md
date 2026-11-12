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

## Card billing (Stripe)

`apps/api/src/lib/billing.ts`. Each business pays Lugali its plan monthly by card through Stripe.
(Businesses charge their own customers with Mercado Pago; that's separate.)

Env (Vercel, production): `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Webhook endpoint in
Stripe: `https://www.lugali.com/api/webhooks/billing` with events `checkout.session.completed`,
`customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`.
Prices (IVA included) are created in Stripe on first use with lookup keys
`lugali_<plan|extra_business|extra_location>_<cents>`. Without the key, plan changes apply for free.

- `PUT /api/tenant/plan`
  - to Gratis: cancels the subscription, plan changes now;
  - with a live subscription: items updated with `proration_behavior=always_invoice` (charged now);
  - otherwise: Stripe Checkout (`checkoutUrl`); the plan changes when the webhook says it's active.
- `POST /api/tenant/billing/portal`: Stripe Customer Portal (card, invoices, cancel).
- Sign-up on a paid plan opens on Gratis and sends the owner to Checkout right away.
- Extra locations above the plan's included ones are a quantity line on the same subscription,
  updated when locations change (`syncBillingAmount`), charged prorated at once.
- An extra business is its own subscription (extra-business price); read-only until paid.
- Failed charge → Stripe marks the subscription `past_due` → `billing_status = past_due`; after
  `BILLING_GRACE_DAYS` (7) the business is read-only (`402 billing_read_only`). Paid → active.
  Cancelled in Stripe → plan Gratis.
- Daily cron (`/api/cron/reset-demo`) re-reads every subscription (`reconcileBilling`).
- Demo businesses (`*-demo`) are never charged.

Fees (nov 2026): Stripe México 3.6% + $3 MXN per charge + 0.7% Billing; no monthly fee.
