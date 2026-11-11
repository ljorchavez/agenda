import { and, eq, sql } from 'drizzle-orm';
import {
  couponsEnabled,
  discountCents,
  rewardSettingsOf,
  type CouponDto,
  type DiscountPreviewDto,
  type TenantSettings,
} from '@agenda/shared';
import type { Db } from '../db/client.js';
import { coupons, type Coupon } from '../db/schema.js';
import { AppError } from './errors.js';

type Q = Pick<Db, 'execute' | 'query'>;

/** Bookings (not cancelled) that used each coupon. */
export async function couponUses(db: Pick<Db, 'execute'>, tenantId: string): Promise<Map<string, number>> {
  const res = await db.execute<{ coupon_id: string; uses: string }>(sql`
    select coupon_id, count(*) as uses from appointments
    where tenant_id = ${tenantId} and coupon_id is not null and status <> 'cancelled'
    group by coupon_id`);
  return new Map(res.rows.map((r) => [r.coupon_id, Number(r.uses)]));
}

export const toCouponDto = (c: Coupon, uses: number): CouponDto => ({
  id: c.id,
  code: c.code,
  discountType: c.discountType,
  value: c.value,
  active: c.active,
  maxUses: c.maxUses,
  validUntil: c.validUntil,
  serviceIds: c.serviceIds ?? [],
  maxUsesPerCustomer: c.maxUsesPerCustomer,
  uses,
});

/** The coupon behind a code, or why it can't be used. */
export async function findUsableCoupon(
  db: Q,
  tenantId: string,
  settings: TenantSettings,
  code: string,
  today: string,
  /** Booking it would apply to: the service must be covered and the customer within their limit */
  use: { serviceId?: string | null; customerId?: string | null } = {},
): Promise<Coupon> {
  if (!couponsEnabled(settings)) throw new AppError(422, 'coupon_invalid', 'Coupons are off');
  const c = await db.query.coupons.findFirst({
    where: and(eq(coupons.tenantId, tenantId), sql`upper(${coupons.code}) = ${code.trim().toUpperCase()}`),
  });
  if (!c || !c.active) throw new AppError(422, 'coupon_invalid', 'Unknown or inactive code');
  if (c.validUntil && c.validUntil < today) throw new AppError(422, 'coupon_expired', 'The code expired');
  if (c.maxUses != null && ((await couponUses(db, tenantId)).get(c.id) ?? 0) >= c.maxUses) {
    throw new AppError(422, 'coupon_used_up', 'The code has no uses left');
  }
  if (use.serviceId && c.serviceIds.length && !c.serviceIds.includes(use.serviceId)) {
    throw new AppError(422, 'coupon_not_for_service', 'The code is not valid for this service');
  }
  if (use.customerId && c.maxUsesPerCustomer != null) {
    const res = await db.execute<{ n: string }>(sql`
      select count(*) as n from appointments
      where tenant_id = ${tenantId} and coupon_id = ${c.id} and customer_id = ${use.customerId} and status <> 'cancelled'`);
    if (Number(res.rows[0]?.n ?? 0) >= c.maxUsesPerCustomer) throw new AppError(422, 'coupon_already_used', 'This customer already used the code');
  }
  return c;
}

/** Completed visits since the last reward (rewards on cancelled bookings don't count as used). */
export async function rewardProgress(db: Pick<Db, 'execute'>, tenantId: string, customerId: string, settings: TenantSettings) {
  const r = rewardSettingsOf(settings);
  if (!r.enabled) return null;
  const res = await db.execute<{ n: string; pending: string }>(sql`
    with last_reward as (
      select max(starts_at) as at from appointments
      where tenant_id = ${tenantId} and customer_id = ${customerId}
        and discount_reason = 'reward' and status <> 'cancelled'
    )
    select
      (select count(*) from appointments a, last_reward l
        where a.tenant_id = ${tenantId} and a.customer_id = ${customerId} and a.status = 'completed'
          and (l.at is null or a.starts_at > l.at)) as n,
      (select count(*) from appointments a, last_reward l
        where a.tenant_id = ${tenantId} and a.customer_id = ${customerId}
          and a.discount_reason = 'reward' and a.status in ('scheduled', 'confirmed')) as pending`);
  const visitsSince = Number(res.rows[0]?.n ?? 0);
  // A reward already waiting on an upcoming booking isn't given twice.
  const pending = Number(res.rows[0]?.pending ?? 0) > 0;
  return { enabled: true, everyVisits: r.everyVisits, visitsSince, eligible: !pending && visitsSince >= r.everyVisits, settings: r };
}

/**
 * Discount for a booking of `priceCents`: the better of the loyalty reward and the coupon (they
 * don't add up). A bad coupon throws unless `soft` (previews report it instead).
 */
export async function resolveDiscount(
  db: Q,
  tenant: { id: string; settings: TenantSettings },
  o: { customerId: string | null; serviceId?: string | null; couponCode?: string | null; priceCents: number; today: string; soft?: boolean },
): Promise<DiscountPreviewDto & { couponId: string | null }> {
  const progress = o.customerId ? await rewardProgress(db, tenant.id, o.customerId, tenant.settings) : null;
  let coupon: Coupon | null = null;
  let couponError: string | null = null;
  if (o.couponCode?.trim()) {
    try {
      coupon = await findUsableCoupon(db, tenant.id, tenant.settings, o.couponCode, o.today, { serviceId: o.serviceId, customerId: o.customerId });
    } catch (e) {
      if (!o.soft || !(e instanceof AppError)) throw e;
      couponError = e.code;
    }
  }
  const rewardOff = progress?.eligible ? discountCents(o.priceCents, progress.settings) : 0;
  const couponOff = coupon ? discountCents(o.priceCents, coupon) : 0;
  const reward = progress ? { enabled: true, everyVisits: progress.everyVisits, visitsSince: progress.visitsSince, eligible: progress.eligible } : null;
  if (couponOff > 0 && couponOff >= rewardOff) {
    return { discountCents: couponOff, reason: 'coupon', couponCode: coupon!.code, couponId: coupon!.id, couponError, reward };
  }
  if (rewardOff > 0) return { discountCents: rewardOff, reason: 'reward', couponCode: null, couponId: null, couponError, reward };
  return { discountCents: 0, reason: null, couponCode: null, couponId: null, couponError, reward };
}
