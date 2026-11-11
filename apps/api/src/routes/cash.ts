import { Hono, type Context } from 'hono';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { z } from 'zod';
import {
  CASH_METHODS,
  cashClosingSchema,
  type CashClosingDto,
  type CashSummaryDto,
  type CommissionReportDto,
} from '@agenda/shared';
import { getDb, type Db } from '../db/client.js';
import { cashClosings, locations, resources, tenants, users } from '../db/schema.js';
import { getScope } from '../lib/access.js';
import { AppError, notFound } from '../lib/errors.js';
import { guardRow, locationForWrite } from '../lib/locations.js';
import { assertFeature } from '../lib/plan.js';
import { isManager } from '@agenda/shared';
import { requireManager, type AppEnv } from '../middleware/auth.js';

/**
 * Commissions per team member and the daily cash closing (corte de caja) per location.
 * - Owners and admins see everything; a gerente only their location.
 * - Team members with their own agenda see only their own commissions; they can't do closings.
 */
export const cashRoutes = new Hono<AppEnv>();

const tenantOf = async (db: Db, id: string) => {
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, id) });
  if (!t) throw notFound('tenant');
  return t;
};
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Sets a team member's commission: general percent + per-service percents that replace it. */
cashRoutes.put('/resources/:id/commission', requireManager, async (c) => {
  const body = z
    .object({ commissionPct: z.number().min(0).max(100).nullable(), commissionByService: z.record(z.string().uuid(), z.number().min(0).max(100)).default({}) })
    .parse(await c.req.json());
  const db = getDb();
  await assertFeature(db, c.get('tenantId'), 'cash');
  const r = await db.query.resources.findFirst({ where: and(eq(resources.id, c.req.param('id')), eq(resources.tenantId, c.get('tenantId'))) });
  if (!r) throw notFound('resource');
  guardRow(c, r.locationId);
  await db
    .update(resources)
    .set({ commissionPct: body.commissionPct == null ? null : String(body.commissionPct), commissionByService: body.commissionByService, updatedAt: new Date() })
    .where(eq(resources.id, r.id));
  return c.json({ ok: true });
});

/**
 * Completed bookings per team member in [from, to] (business days) with what they sold and the
 * commission. A booking paid with a package counts at its full price (the package was sold).
 */
cashRoutes.get('/reports/commissions', async (c) => {
  const q = z.object({ from: isoDay, to: isoDay, locationId: z.string().uuid().optional() }).parse(c.req.query());
  const db = getDb();
  const tenantId = c.get('tenantId');
  await assertFeature(db, tenantId, 'cash');
  const t = await tenantOf(db, tenantId);
  const scope = await getScope(db, c);
  if (!isManager(c.get('role')) && !scope.personal) throw new AppError(403, 'forbidden', 'Not allowed');
  const from = DateTime.fromISO(q.from, { zone: t.timezone }).startOf('day').toJSDate();
  const to = DateTime.fromISO(q.to, { zone: t.timezone }).endOf('day').toJSDate();
  const loc = scope.locationId ?? q.locationId ?? null;
  const res = await db.execute<{
    appointment_id: string; resource_id: string; resource_name: string; starts_at: Date; service_name: string; customer_name: string; price: number; pct: string;
  }>(sql`
    select a.id as appointment_id, r.id as resource_id, r.name as resource_name, a.starts_at, s.name as service_name, cu.name as customer_name,
           (case when a.discount_reason = 'package' then a.price_cents + a.discount_cents else a.price_cents end) as price,
           coalesce((r.commission_by_service ->> a.service_id::text)::numeric, r.commission_pct, 0) as pct
    from appointments a
    left join class_sessions cs on cs.id = a.class_session_id
    join resources r on r.id = coalesce(a.resource_id, cs.resource_id)
    join services s on s.id = a.service_id
    join customers cu on cu.id = a.customer_id
    where a.tenant_id = ${tenantId} and a.status = 'completed' and a.starts_at >= ${from} and a.starts_at <= ${to}
      ${loc ? sql`and a.location_id = ${loc}` : sql``}
      ${scope.personal ? sql`and r.id = ${scope.resourceId}` : sql``}
    order by r.name, a.starts_at`);
  const lines = res.rows.map((r) => {
    const pct = Number(r.pct);
    return {
      appointmentId: r.appointment_id,
      resourceId: r.resource_id,
      resourceName: r.resource_name,
      startsAt: new Date(r.starts_at).toISOString(),
      serviceName: r.service_name,
      customerName: r.customer_name,
      priceCents: Number(r.price),
      pct,
      commissionCents: Math.round((Number(r.price) * pct) / 100),
    };
  });
  const by = new Map<string, CommissionReportDto['rows'][number]>();
  for (const l of lines) {
    const row = by.get(l.resourceId) ?? { resourceId: l.resourceId, resourceName: l.resourceName, completed: 0, soldCents: 0, commissionCents: 0 };
    row.completed += 1;
    row.soldCents += l.priceCents;
    row.commissionCents += l.commissionCents;
    by.set(l.resourceId, row);
  }
  const body: CommissionReportDto = { rows: [...by.values()], lines: lines.map(({ resourceId: _r, ...l }) => l) };
  return c.json(body);
});

/** Only owners and admins (a gerente for their location) handle the cash. */
async function cashLocation(c: Context<AppEnv>, requested: string | undefined) {
  if (!isManager(c.get('role'))) throw new AppError(403, 'forbidden', 'Only owners and admins');
  const db = getDb();
  await assertFeature(db, c.get('tenantId'), 'cash');
  return (await locationForWrite(db, c, requested, { create: true }))!;
}

async function summary(db: Db, tenantId: string, tz: string, day: string, locationId: string): Promise<CashSummaryDto> {
  const from = DateTime.fromISO(day, { zone: tz }).startOf('day').toJSDate();
  const to = DateTime.fromISO(day, { zone: tz }).endOf('day').toJSDate();
  const res = await db.execute<{ method: string; total: string; sale: string | null }>(sql`
    select p.method::text as method, sum(p.amount_cents) as total,
           case when p.sold_gift_card_id is not null then 'gift_cards'
                when cp.kind = 'membership' then 'memberships'
                when cp.kind = 'package' then 'packages' end as sale
    from payments p
    left join appointments a on a.id = p.appointment_id
    left join customer_plans cp on cp.id = p.customer_plan_id
    where p.tenant_id = ${tenantId} and p.status = 'paid' and p.paid_at >= ${from} and p.paid_at <= ${to}
      and coalesce(p.location_id, a.location_id) = ${locationId}
    group by 1, 3`);
  const byMethod: Record<string, number> = Object.fromEntries(CASH_METHODS.map((m) => [m, 0]));
  const salesByKind = { packages: 0, memberships: 0, giftCards: 0 };
  for (const r of res.rows) {
    byMethod[r.method] = (byMethod[r.method] ?? 0) + Number(r.total);
    if (r.sale === 'packages') salesByKind.packages += Number(r.total);
    if (r.sale === 'memberships') salesByKind.memberships += Number(r.total);
    if (r.sale === 'gift_cards') salesByKind.giftCards += Number(r.total);
  }
  const salesCents = salesByKind.packages + salesByKind.memberships + salesByKind.giftCards;
  // Gift card payments are listed but aren't new money (it came in when the card was sold).
  const totalCents = Object.entries(byMethod).reduce((a, [m, v]) => (m === 'gift_card' ? a : a + v), 0);
  return { day, locationId, byMethod, salesCents, salesByKind, expectedCashCents: byMethod.cash ?? 0, totalCents };
}

cashRoutes.get('/cash/summary', async (c) => {
  const q = z.object({ day: isoDay, locationId: z.string().uuid().optional() }).parse(c.req.query());
  const locationId = await cashLocation(c, q.locationId);
  const db = getDb();
  const t = await tenantOf(db, c.get('tenantId'));
  return c.json(await summary(db, t.id, t.timezone, q.day, locationId));
});

cashRoutes.post('/cash/closings', async (c) => {
  const input = cashClosingSchema.parse(await c.req.json());
  const locationId = await cashLocation(c, input.locationId);
  const db = getDb();
  const t = await tenantOf(db, c.get('tenantId'));
  const s = await summary(db, t.id, t.timezone, input.day, locationId);
  const name = (await db.query.users.findFirst({ where: eq(users.id, c.get('userId')), columns: { name: true } }))?.name ?? null;
  const [row] = await db
    .insert(cashClosings)
    .values({
      tenantId: t.id, locationId, day: input.day, byMethod: s.byMethod, salesCents: s.salesCents, expectedCashCents: s.expectedCashCents,
      countedCashCents: input.countedCashCents, notes: input.notes ?? null, closedBy: c.get('userId'), closedByName: name,
    })
    .returning();
  return c.json({ id: row!.id }, 201);
});

cashRoutes.get('/cash/closings', async (c) => {
  const q = z.object({ from: isoDay.optional(), to: isoDay.optional(), locationId: z.string().uuid().optional() }).parse(c.req.query());
  if (!isManager(c.get('role'))) throw new AppError(403, 'forbidden', 'Only owners and admins');
  const db = getDb();
  const tenantId = c.get('tenantId');
  await assertFeature(db, tenantId, 'cash');
  const own = c.get('role') === 'owner' ? null : c.get('locationId');
  const loc = own ?? q.locationId;
  const rows = await db
    .select({ x: cashClosings, locationName: locations.name })
    .from(cashClosings)
    .innerJoin(locations, eq(locations.id, cashClosings.locationId))
    .where(
      and(
        eq(cashClosings.tenantId, tenantId),
        loc ? eq(cashClosings.locationId, loc) : undefined,
        q.from ? gte(cashClosings.day, q.from) : undefined,
        q.to ? lte(cashClosings.day, q.to) : undefined,
      ),
    )
    .orderBy(desc(cashClosings.day), desc(cashClosings.createdAt))
    .limit(200);
  const out: CashClosingDto[] = rows.map(({ x, locationName }) => ({
    id: x.id,
    day: x.day,
    locationId: x.locationId,
    locationName,
    byMethod: x.byMethod,
    salesCents: x.salesCents,
    expectedCashCents: x.expectedCashCents,
    countedCashCents: x.countedCashCents,
    differenceCents: x.countedCashCents - x.expectedCashCents,
    notes: x.notes,
    closedByName: x.closedByName,
    createdAt: x.createdAt.toISOString(),
  }));
  return c.json(out);
});
