# Billing model

Each business (tenant) has its own plan (`tenants.plan`). Limits and prices live only in
`packages/shared` (`PLAN_LIMITS`, `ADDON_PRICES`) and are enforced in `apps/api/src/lib/plan.ts`.

| Plan     | Price (provisional) | Customers | Bookings / month | Locations | Other businesses |
|----------|---------------------|-----------|------------------|-----------|------------------|
| Gratis   | $0                  | 5         | no limit         | 1         | no               |
| Estándar | $399 / month        | no limit  | 500              | 1 + extras| yes (each extra) |
| Premium  | to be defined       | no limit  | no limit         | 1 + extras| yes              |

Features by plan (`PLAN_LIMITS.packages | records | cash | recordPhotosMb`):

| Feature | Gratis | Estándar | Premium |
|---|---|---|---|
| Verified reviews, iCal calendar links | ✓ | ✓ | ✓ |
| Packages, memberships, gift cards | – | ✓ | ✓ |
| Client record (encrypted) + questionnaires per booking type | – | ✓ (1 GB photos) | ✓ (10 GB photos) |
| Commissions and cash closing | – | ✓ | ✓ |

Missing feature → **402** `plan_limit_packages | plan_limit_records | plan_limit_cash`; photo
storage full → `plan_limit_photos`.

Add-ons: extra active location $199 / month, extra business $299 / month (includes Estándar).
Over a limit the API answers **402** with `plan_limit_customers | plan_limit_bookings |
plan_limit_locations | plan_limit_businesses`. Logins (admins, gerentes, colaboradores) are free.

- Sign-up (`/registro`) starts with the plan cards, then the account form (`plan` in `/auth/register`).
- Settings → Plan y uso: current plan, usage, monthly total and plan change (`GET/PUT /api/tenant/plan`, owner only).
- Demo businesses are seeded on Premium so their history doesn't hit limits.

## Card billing (to connect)

`apps/api/src/lib/billing.ts` defines `BillingProvider` (`checkoutUrl`, `portalUrl`).
`billingProvider()` returns `null` today, so plan changes apply right away without a charge.
When a provider is set, `PUT /api/tenant/plan` returns its checkout URL and the plan should
change from the provider's webhook (to add: `/api/webhooks/billing`, `tenants.plan_status`,
read-only mode when a payment fails).

Options considered: Stripe Billing (subscriptions with proration, customer portal, receipts)
or Mercado Pago Suscripciones (preapproval; plan changes = cancel + new subscription).
