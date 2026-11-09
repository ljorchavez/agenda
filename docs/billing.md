# Billing model (notes)

Decided with the founder: **charge per business, plus extra locations**.

- **Per business.** Each business (tenant) has its own plan, even when one person owns several.
  One login can own several businesses (`memberships`), but each one is billed separately.
- **Locations.** A plan includes `PLAN_INCLUDED_LOCATIONS` (1, in `packages/shared`).
  Every additional **active** location is an add-on. Inactive locations aren't billed.
- `GET /api/locations` returns `plan: { includedLocations, activeLocations, extraLocations }`.
  Settings → Sucursales shows it, and a warning appears before adding a location.

## Not built yet

- Plans, prices and payment collection (subscriptions). Suggested approach: Mercado Pago
  subscriptions (preapproval) on the platform's own account, one per business, with the
  quantity of extra locations as a line item; webhook updates `tenants.plan_status`.
- Limits when a plan is unpaid (read-only mode, booking page paused).
- Proration when locations are added or removed mid-cycle (simplest: bill the peak count of the month).
- Seats are not billed: logins (admins, gerentes, colaboradores) are unlimited.
