import { Hono } from 'hono';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import {
  giftCardRedeemSchema,
  giftCardSaleSchema,
  offeringInputSchema,
  planSaleSchema,
  type GiftCardDto,
  type OfferingDto,
} from '@agenda/shared';
import { getDb, type Db } from '../db/client.js';
import { appointments, customerPlans, customers, giftCards, offerings, payments, planUses, tenants, type Offering } from '../db/schema.js';
import { getScope, inScope } from '../lib/access.js';
import { AppError, notFound } from '../lib/errors.js';
import { locationForWrite } from '../lib/locations.js';
import { assertFeature } from '../lib/plan.js';
import { customerPlans as listPlans, giftCardCode, plansFor, setPlanUse } from '../lib/plans.js';
import { requireBusinessManager, type AppEnv } from '../middleware/auth.js';
import type { Context } from 'hono';

/**
 * Packages (N sessions within D days), monthly memberships and gift cards: the catalog, selling
 * them to a customer (a manual payment for now), taking sessions from them and paying with a
 * gift card balance.
 */
export const saleRoutes = new Hono<AppEnv>();

const tenantOf = async (db: Db, id: string) => {
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
  if (!t) throw notFound('tenant');
  return t;
};
const today = (tz: string) => DateTime.now().setZone(tz).toISODate()!;

/** Colaboradores with their own agenda don't sell; front desk, managers and owners do. */
async function assertSeller(c: Context<AppEnv>) {
  const scope = await getScope(getDb(), c);
  if (scope.personal) throw new AppError(403, 'forbidden', 'Your role cannot sell');
}

const toOfferingDto = (o: Offering, activeCount: number): OfferingDto => ({
  id: o.id,
  kind: o.kind,
  name: o.name,
  priceCents: o.priceCents,
  sessions: o.sessions,
  validityDays: o.validityDays,
  serviceIds: o.serviceIds ?? [],
  active: o.active,
  activeCount,
});

saleRoutes.get('/offerings', async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const t = await tenantOf(db, tenantId);
  const rows = await db.select().from(offerings).where(eq(offerings.tenantId, tenantId)).orderBy(asc(offerings.kind), asc(offerings.name));
  const counts = await db.execute<{ offering_id: string; n: string }>(sql`
    select offering_id, count(*) as n from customer_plans
    where tenant_id = ${tenantId} and cancelled_at is null and (expires_on is null or expires_on >= ${today(t.timezone)})
    group by offering_id`);
  const by = new Map(counts.rows.map((r) => [r.offering_id, Number(r.n)]));
  return c.json(rows.map((o) => toOfferingDto(o, by.get(o.id) ?? 0)));
});

const offeringValues = (i: ReturnType<typeof offeringInputSchema.parse>) => ({
  kind: i.kind,
  name: i.name,
  priceCents: i.priceCents,
  sessions: i.sessions ?? null,
  validityDays: i.kind === 'package' ? i.validityDays ?? null : null,
  serviceIds: [...new Set(i.serviceIds)],
  active: i.active,
});

saleRoutes.post('/offerings', requireBusinessManager, async (c) => {
  const input = offeringInputSchema.parse(await c.req.json());
  const db = getDb();
  await assertFeature(db, c.get('tenantId'), 'packages');
  const [row] = await db.insert(offerings).values({ tenantId: c.get('tenantId'), ...offeringValues(input) }).returning();
  return c.json(toOfferingDto(row!, 0), 201);
});

saleRoutes.put('/offerings/:id', requireBusinessManager, async (c) => {
  const input = offeringInputSchema.parse(await c.req.json());
  const [row] = await getDb()
    .update(offerings)
    .set({ ...offeringValues(input), updatedAt: new Date() })
    .where(and(eq(offerings.id, c.req.param('id')), eq(offerings.tenantId, c.get('tenantId'))))
    .returning();
  if (!row) throw notFound('offering');
  return c.json(toOfferingDto(row, 0));
});

/** Sold ones stay on the customers' records; the catalog item is just hidden. */
saleRoutes.delete('/offerings/:id', requireBusinessManager, async (c) => {
  const db = getDb();
  const where = and(eq(offerings.id, c.req.param('id')), eq(offerings.tenantId, c.get('tenantId')));
  const sold = await db.query.customerPlans.findFirst({ where: eq(customerPlans.offeringId, c.req.param('id')) });
  const [row] = sold
    ? await db.update(offerings).set({ active: false, updatedAt: new Date() }).where(where).returning({ id: offerings.id })
    : await db.delete(offerings).where(where).returning({ id: offerings.id });
  if (!row) throw notFound('offering');
  return c.body(null, 204);
});

const findCustomer = async (db: Db, tenantId: string, id: string) => {
  const cu = await db.query.customers.findFirst({ where: and(eq(customers.id, id), eq(customers.tenantId, tenantId)) });
  if (!cu) throw notFound('customer');
  return cu;
};

/** A customer's packages and memberships (with their uses) and gift cards. */
saleRoutes.get('/customers/:id/plans', async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const t = await tenantOf(db, tenantId);
  await findCustomer(db, tenantId, c.req.param('id'));
  const plans = await listPlans(db, tenantId, c.req.param('id'), today(t.timezone));
  const cards = await giftCardList(db, tenantId, c.req.param('id'));
  return c.json({ plans, giftCards: cards });
});

/** Sells a package or a month of membership, with its payment. */
saleRoutes.post('/customers/:id/plans', async (c) => {
  await assertSeller(c);
  const input = planSaleSchema.parse(await c.req.json());
  const db = getDb();
  const tenantId = c.get('tenantId');
  await assertFeature(db, tenantId, 'packages');
  const t = await tenantOf(db, tenantId);
  const cu = await findCustomer(db, tenantId, c.req.param('id'));
  const o = await db.query.offerings.findFirst({ where: and(eq(offerings.id, input.offeringId), eq(offerings.tenantId, tenantId)) });
  if (!o || !o.active) throw notFound('offering');
  const locationId = (await locationForWrite(db, c, input.locationId, { create: true }))!;
  const start = DateTime.fromISO(input.startsOn ?? today(t.timezone));
  const expires = o.kind === 'membership' ? start.plus({ months: 1 }).minus({ days: 1 }) : start.plus({ days: (o.validityDays ?? 30) - 1 });
  const price = input.priceCents ?? o.priceCents;
  const plan = await db.transaction(async (tx) => {
    const [p] = await tx
      .insert(customerPlans)
      .values({
        tenantId,
        customerId: cu.id,
        offeringId: o.id,
        kind: o.kind,
        name: o.name,
        serviceIds: o.serviceIds ?? [],
        sessionsTotal: o.sessions,
        priceCents: price,
        startsOn: start.toISODate()!,
        expiresOn: expires.toISODate()!,
        locationId,
        soldBy: c.get('userId'),
      })
      .returning();
    if (price > 0) {
      await tx.insert(payments).values({
        tenantId, customerId: cu.id, amountCents: price, method: input.method, status: 'paid', paidAt: new Date(),
        locationId, customerPlanId: p!.id, notes: o.name,
      });
    }
    return p!;
  });
  return c.json({ id: plan.id }, 201);
});

saleRoutes.post('/customer-plans/:id/cancel', requireBusinessManager, async (c) => {
  const [row] = await getDb()
    .update(customerPlans)
    .set({ cancelledAt: new Date(), updatedAt: new Date() })
    .where(and(eq(customerPlans.id, c.req.param('id')), eq(customerPlans.tenantId, c.get('tenantId'))))
    .returning({ id: customerPlans.id });
  if (!row) throw notFound('plan');
  return c.body(null, 204);
});

// ---------- Taking sessions ----------

const loadAppt = async (c: Context<AppEnv>) => {
  const db = getDb();
  const a = await db.query.appointments.findFirst({ where: and(eq(appointments.id, c.req.param('id')!), eq(appointments.tenantId, c.get('tenantId'))) });
  if (!a) throw notFound('appointment');
  const scope = await getScope(db, c);
  if (!inScope(scope, a)) throw notFound('appointment');
  return a;
};

/** Plans this booking can take a session from, and the one it used (if any). */
saleRoutes.get('/appointments/:id/plans', async (c) => {
  const db = getDb();
  const a = await loadAppt(c);
  const t = await tenantOf(db, a.tenantId);
  const used = await db.query.planUses.findFirst({ where: eq(planUses.appointmentId, a.id) });
  const choices = await plansFor(db, a.tenantId, a, t.timezone);
  let usedName: string | null = null;
  if (used) usedName = (await db.query.customerPlans.findFirst({ where: eq(customerPlans.id, used.customerPlanId) }))?.name ?? null;
  return c.json({ choices, usedPlanId: used?.customerPlanId ?? null, usedPlanName: usedName });
});

/** Takes the session from a plan (`planId`) or charges normally (`planId: null`). */
saleRoutes.post('/appointments/:id/use-plan', async (c) => {
  const body = (await c.req.json()) as { planId?: string | null };
  const planId = typeof body.planId === 'string' ? body.planId : null;
  const db = getDb();
  const a = await loadAppt(c);
  const t = await tenantOf(db, a.tenantId);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select id from appointments where id = ${a.id} for update`);
    const fresh = (await tx.query.appointments.findFirst({ where: eq(appointments.id, a.id) }))!;
    await setPlanUse(tx as unknown as Db, a.tenantId, fresh, planId, t.timezone, c.get('userId'));
  });
  return c.json({ ok: true });
});

// ---------- Gift cards ----------

async function giftCardList(db: Db, tenantId: string, customerId?: string): Promise<GiftCardDto[]> {
  const rows = await db
    .select({ g: giftCards, customerName: customers.name })
    .from(giftCards)
    .leftJoin(customers, eq(customers.id, giftCards.customerId))
    .where(and(eq(giftCards.tenantId, tenantId), customerId ? eq(giftCards.customerId, customerId) : undefined))
    .orderBy(desc(giftCards.createdAt))
    .limit(500);
  return rows.map(({ g, customerName }) => ({
    id: g.id,
    code: g.code,
    initialCents: g.initialCents,
    balanceCents: g.balanceCents,
    customerId: g.customerId,
    customerName,
    recipientName: g.recipientName,
    expiresOn: g.expiresOn,
    createdAt: g.createdAt.toISOString(),
  }));
}

saleRoutes.get('/gift-cards', async (c) => c.json(await giftCardList(getDb(), c.get('tenantId'))));

saleRoutes.get('/gift-cards/:code', async (c) => {
  const db = getDb();
  const g = await db.query.giftCards.findFirst({
    where: and(eq(giftCards.tenantId, c.get('tenantId')), eq(giftCards.code, c.req.param('code').trim().toUpperCase())),
  });
  if (!g) throw new AppError(404, 'gift_card_not_found', 'Unknown gift card');
  return c.json({ code: g.code, balanceCents: g.balanceCents, expiresOn: g.expiresOn });
});

saleRoutes.post('/gift-cards', async (c) => {
  await assertSeller(c);
  const input = giftCardSaleSchema.parse(await c.req.json());
  const db = getDb();
  const tenantId = c.get('tenantId');
  await assertFeature(db, tenantId, 'packages');
  const cu = await findCustomer(db, tenantId, input.customerId);
  const locationId = (await locationForWrite(db, c, input.locationId, { create: true }))!;
  const card = await db.transaction(async (tx) => {
    let code = giftCardCode();
    for (let i = 0; i < 5 && (await tx.query.giftCards.findFirst({ where: and(eq(giftCards.tenantId, tenantId), eq(giftCards.code, code)) })); i++) code = giftCardCode();
    const [g] = await tx
      .insert(giftCards)
      .values({
        tenantId, code, initialCents: input.amountCents, balanceCents: input.amountCents, customerId: cu.id,
        recipientName: input.recipientName ?? null, expiresOn: input.expiresOn ?? null, locationId, soldBy: c.get('userId'),
      })
      .returning();
    await tx.insert(payments).values({
      tenantId, customerId: cu.id, amountCents: input.amountCents, method: input.method, status: 'paid', paidAt: new Date(),
      locationId, soldGiftCardId: g!.id, notes: `Tarjeta de regalo ${code}`,
    });
    return g!;
  });
  return c.json({ id: card.id, code: card.code }, 201);
});

/** Pays (part of) a booking with a gift card: takes the amount from its balance. */
saleRoutes.post('/gift-cards/redeem', async (c) => {
  const input = giftCardRedeemSchema.parse(await c.req.json());
  const db = getDb();
  const tenantId = c.get('tenantId');
  const t = await tenantOf(db, tenantId);
  const a = await db.query.appointments.findFirst({ where: and(eq(appointments.id, input.appointmentId), eq(appointments.tenantId, tenantId)) });
  if (!a) throw notFound('appointment');
  if (!inScope(await getScope(db, c), a)) throw notFound('appointment');
  const out = await db.transaction(async (tx) => {
    const res = await tx.execute<{ id: string; balance_cents: number; expires_on: string | null }>(sql`
      select id, balance_cents, expires_on from gift_cards
      where tenant_id = ${tenantId} and code = ${input.code.trim().toUpperCase()} for update`);
    const g = res.rows[0];
    if (!g) throw new AppError(404, 'gift_card_not_found', 'Unknown gift card');
    if (g.expires_on && String(g.expires_on).slice(0, 10) < today(t.timezone)) throw new AppError(422, 'gift_card_expired', 'The gift card expired');
    if (g.balance_cents < input.amountCents) throw new AppError(422, 'gift_card_balance', 'Not enough balance', { balanceCents: g.balance_cents });
    await tx.update(giftCards).set({ balanceCents: g.balance_cents - input.amountCents, updatedAt: new Date() }).where(eq(giftCards.id, g.id));
    await tx.insert(payments).values({
      tenantId, customerId: a.customerId, appointmentId: a.id, amountCents: input.amountCents, method: 'gift_card',
      status: 'paid', paidAt: new Date(), giftCardId: g.id, locationId: a.locationId,
    });
    return { balanceCents: g.balance_cents - input.amountCents };
  });
  return c.json(out, 201);
});
