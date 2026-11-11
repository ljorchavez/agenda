import { and, asc, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { PLAN_LIMITS, salesSettingsOf, type OnlinePurchase, type PublicShopDto, type PurchaseStatusDto } from '@agenda/shared';
import type { Db } from '../db/client.js';
import { customerPlans, giftCards, locations, offerings, payments, services, tenants, type Payment, type Tenant } from '../db/schema.js';
import { tenantMpToken } from './online-payments.js';
import { giftCardCode } from './plans.js';

/**
 * Online sales on the booking page: packages, memberships and gift cards paid with the
 * business's own Mercado Pago. The payment is created pending with what it buys (`purchase`);
 * the plan or the gift card is created once Mercado Pago confirms it (webhook), only once.
 */

/** What the booking page offers, or null when the business doesn't sell online. */
export async function shopFor(db: Pick<Db, 'select'>, tenant: Tenant): Promise<PublicShopDto | null> {
  const sales = salesSettingsOf(tenant.settings);
  if (!sales.online || !PLAN_LIMITS[tenant.plan].packages || !tenantMpToken(tenant)) return null;
  const rows = await db
    .select()
    .from(offerings)
    .where(and(eq(offerings.tenantId, tenant.id), eq(offerings.active, true)))
    .orderBy(asc(offerings.priceCents));
  const svc = await db.select({ id: services.id, name: services.name }).from(services).where(eq(services.tenantId, tenant.id));
  const name = new Map(svc.map((s) => [s.id, s.name]));
  const list = rows
    .filter((o) => o.priceCents > 0)
    .map((o) => ({
      id: o.id,
      kind: o.kind,
      name: o.name,
      priceCents: o.priceCents,
      sessions: o.sessions,
      validityDays: o.validityDays,
      serviceNames: (o.serviceIds ?? []).map((id) => name.get(id)).filter((n): n is string => Boolean(n)),
    }));
  if (!list.length && !sales.giftCardAmounts.length) return null;
  return { offerings: list, giftCardAmounts: sales.giftCardAmounts };
}

const primaryLocation = async (db: Pick<Db, 'select'>, tenantId: string) =>
  (await db.select({ id: locations.id }).from(locations).where(and(eq(locations.tenantId, tenantId), eq(locations.isPrimary, true))).limit(1))[0]?.id ??
  null;

/**
 * Creates what a paid online payment bought (plan or gift card). Idempotent: the payment row is
 * locked and skipped when it already points to its plan/gift card.
 */
export async function fulfilPurchase(db: Db, paymentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const res = await tx.execute<{ id: string }>(sql`
      select id from payments where id = ${paymentId} and status = 'paid' and purchase is not null
        and customer_plan_id is null and sold_gift_card_id is null for update`);
    if (!res.rows.length) return;
    const p = (await tx.query.payments.findFirst({ where: eq(payments.id, paymentId) }))!;
    const t = (await tx.query.tenants.findFirst({ where: eq(tenants.id, p.tenantId) }))!;
    const purchase = p.purchase!;
    const locationId = p.locationId ?? (await primaryLocation(tx, t.id));
    const today = DateTime.now().setZone(t.timezone);
    if (purchase.kind === 'plan') {
      const o = await tx.query.offerings.findFirst({ where: and(eq(offerings.id, purchase.offeringId), eq(offerings.tenantId, t.id)) });
      if (!o) return;
      const expires = o.kind === 'membership' ? today.plus({ months: 1 }).minus({ days: 1 }) : today.plus({ days: (o.validityDays ?? 30) - 1 });
      const [plan] = await tx
        .insert(customerPlans)
        .values({
          tenantId: t.id,
          customerId: p.customerId,
          offeringId: o.id,
          kind: o.kind,
          name: o.name,
          serviceIds: o.serviceIds ?? [],
          sessionsTotal: o.sessions,
          priceCents: p.amountCents,
          startsOn: today.toISODate()!,
          expiresOn: expires.toISODate()!,
          locationId,
          soldBy: null,
        })
        .returning();
      await tx.update(payments).set({ customerPlanId: plan!.id, locationId }).where(eq(payments.id, p.id));
    } else {
      let code = giftCardCode();
      for (let i = 0; i < 5 && (await tx.query.giftCards.findFirst({ where: and(eq(giftCards.tenantId, t.id), eq(giftCards.code, code)) })); i++) code = giftCardCode();
      const [g] = await tx
        .insert(giftCards)
        .values({
          tenantId: t.id,
          code,
          initialCents: p.amountCents,
          balanceCents: p.amountCents,
          customerId: p.customerId,
          recipientName: purchase.recipientName,
          expiresOn: null,
          locationId,
          soldBy: null,
        })
        .returning();
      await tx.update(payments).set({ soldGiftCardId: g!.id, locationId, notes: `Tarjeta de regalo ${code}` }).where(eq(payments.id, p.id));
    }
  });
}

/** Name of what is being bought (checkout title and the purchase page). */
export async function purchaseItemName(db: Pick<Db, 'query'>, tenantId: string, purchase: OnlinePurchase): Promise<string | null> {
  if (purchase.kind === 'gift_card') return 'Tarjeta de regalo';
  const o = await db.query.offerings.findFirst({ where: and(eq(offerings.id, purchase.offeringId), eq(offerings.tenantId, tenantId)) });
  return o?.name ?? null;
}

/** What the buyer sees on /compra/<token>. */
export async function purchaseStatus(db: Db, p: Payment): Promise<PurchaseStatusDto | null> {
  if (!p.purchase) return null;
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, p.tenantId) });
  if (!t) return null;
  const card = p.soldGiftCardId ? await db.query.giftCards.findFirst({ where: eq(giftCards.id, p.soldGiftCardId) }) : null;
  const plan = p.customerPlanId ? await db.query.customerPlans.findFirst({ where: eq(customerPlans.id, p.customerPlanId) }) : null;
  return {
    status: p.status,
    kind: p.purchase.kind,
    itemName: (await purchaseItemName(db, t.id, p.purchase)) ?? plan?.name ?? 'Compra',
    amountCents: p.amountCents,
    businessName: t.name,
    slug: t.slug,
    giftCardCode: card?.code ?? null,
    recipientName: p.purchase.kind === 'gift_card' ? p.purchase.recipientName : null,
    plan: plan ? { sessionsLeft: plan.sessionsTotal, expiresOn: plan.expiresOn } : null,
  };
}
