import { Hono } from 'hono';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { couponInputSchema } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { coupons } from '../db/schema.js';
import { couponUses, toCouponDto } from '../lib/discounts.js';
import { AppError, notFound } from '../lib/errors.js';
import { requireManager, type AppEnv } from '../middleware/auth.js';

/** Discount codes of the business. Turned on/off in Configuración → Promociones. */
export const couponRoutes = new Hono<AppEnv>();

couponRoutes.get('/coupons', async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const [rows, uses] = await Promise.all([
    db.select().from(coupons).where(eq(coupons.tenantId, tenantId)).orderBy(asc(coupons.code)),
    couponUses(db, tenantId),
  ]);
  return c.json(rows.map((r) => toCouponDto(r, uses.get(r.id) ?? 0)));
});

const assertFreeCode = async (tenantId: string, code: string, exceptId?: string) => {
  const dup = await getDb().query.coupons.findFirst({
    where: and(eq(coupons.tenantId, tenantId), sql`upper(${coupons.code}) = ${code}`, exceptId ? ne(coupons.id, exceptId) : undefined),
  });
  if (dup) throw new AppError(409, 'coupon_exists', 'That code already exists');
};

couponRoutes.post('/coupons', requireManager, async (c) => {
  const input = couponInputSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  await assertFreeCode(tenantId, input.code);
  const [row] = await getDb()
    .insert(coupons)
    .values({ tenantId, ...input, maxUses: input.maxUses ?? null, validUntil: input.validUntil ?? null })
    .returning();
  return c.json(toCouponDto(row!, 0), 201);
});

couponRoutes.put('/coupons/:id', requireManager, async (c) => {
  const input = couponInputSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  await assertFreeCode(tenantId, input.code, id);
  const db = getDb();
  const [row] = await db
    .update(coupons)
    .set({ ...input, maxUses: input.maxUses ?? null, validUntil: input.validUntil ?? null, updatedAt: new Date() })
    .where(and(eq(coupons.id, id), eq(coupons.tenantId, tenantId)))
    .returning();
  if (!row) throw notFound('coupon');
  return c.json(toCouponDto(row, (await couponUses(db, tenantId)).get(row.id) ?? 0));
});

/** Deleting keeps past bookings' discount; they just lose the link to the code. */
couponRoutes.delete('/coupons/:id', requireManager, async (c) => {
  const [row] = await getDb()
    .delete(coupons)
    .where(and(eq(coupons.id, c.req.param('id')), eq(coupons.tenantId, c.get('tenantId'))))
    .returning({ id: coupons.id });
  if (!row) throw notFound('coupon');
  return c.body(null, 204);
});
