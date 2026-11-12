import { and, eq, sql } from 'drizzle-orm';
import { ADDON_PRICES, PLAN_LIMITS, type BillingStatus, type PlanId, type PlanInfoDto, type PlanUsage } from '@agenda/shared';
import { isReadOnly } from './billing.js';
import type { Db } from '../db/client.js';
import { memberships, tenants } from '../db/schema.js';
import { AppError } from './errors.js';

/**
 * Subscription plans: limits are checked here, for every kind of business. Prices and limits
 * live in packages/shared (PLAN_LIMITS, ADDON_PRICES). Card charges go through `billing`.
 */

type Q = Pick<Db, 'execute'>;
const num = (v: unknown) => Number(v ?? 0);

export async function planUsage(db: Q, tenantId: string): Promise<PlanUsage> {
  const res = await db.execute<{ customers: string; resources: string; bookings: string; locations: string; photo_bytes: string }>(sql`
    select
      (select count(*) from customers where tenant_id = ${tenantId}) as customers,
      (select count(*) from resources where tenant_id = ${tenantId} and active) as resources,
      (select count(*) from appointments where tenant_id = ${tenantId}
         and created_at >= date_trunc('month', now())) as bookings,
      (select count(*) from locations where tenant_id = ${tenantId} and active) as locations,
      (select coalesce(sum(size_bytes), 0) from record_photos where tenant_id = ${tenantId}) as photo_bytes`);
  const r = res.rows[0];
  return {
    customers: num(r?.customers),
    activeResources: num(r?.resources),
    bookingsThisMonth: num(r?.bookings),
    activeLocations: num(r?.locations),
    recordPhotosMb: Math.round((num(r?.photo_bytes) / (1024 * 1024)) * 10) / 10,
  };
}

export const planOf = async (db: Q, tenantId: string): Promise<PlanId> => {
  const res = await db.execute<{ plan: PlanId }>(sql`select plan from tenants where id = ${tenantId}`);
  return res.rows[0]?.plan ?? 'free';
};

/** 402 when the plan doesn't include a feature (packages, records, commissions and cash). */
export async function assertFeature(db: Q, tenantId: string, feature: 'packages' | 'records' | 'cash') {
  if (!PLAN_LIMITS[await planOf(db, tenantId)][feature]) {
    throw new AppError(402, `plan_limit_${feature}`, `This plan doesn't include ${feature}`);
  }
}

/** 402 when one more record photo of `bytes` doesn't fit the plan's storage. */
export async function assertPhotoRoom(db: Q, tenantId: string, bytes: number) {
  const mb = PLAN_LIMITS[await planOf(db, tenantId)].recordPhotosMb;
  const used = (await planUsage(db, tenantId)).recordPhotosMb;
  if (used + bytes / (1024 * 1024) > mb) {
    throw new AppError(402, 'plan_limit_photos', `This plan includes ${mb} MB of record photos`);
  }
}

/** 402 when one more customer doesn't fit the plan. */
export async function assertCanAddCustomer(db: Q, tenantId: string) {
  const limit = PLAN_LIMITS[await planOf(db, tenantId)].maxCustomers;
  if (limit == null) return;
  if ((await planUsage(db, tenantId)).customers >= limit) {
    throw new AppError(402, 'plan_limit_customers', `This plan includes up to ${limit} customers`);
  }
}

/** 402 when one more booking this month doesn't fit the plan. */
export async function assertCanAddBooking(db: Q, tenantId: string) {
  const limit = PLAN_LIMITS[await planOf(db, tenantId)].maxBookingsPerMonth;
  if (limit == null) return;
  if ((await planUsage(db, tenantId)).bookingsThisMonth >= limit) {
    throw new AppError(402, 'plan_limit_bookings', `This plan includes up to ${limit} bookings a month`);
  }
}

/** 402 when the plan doesn't allow another active location. */
export async function assertCanAddLocation(db: Q, tenantId: string) {
  const limits = PLAN_LIMITS[await planOf(db, tenantId)];
  if (limits.extraLocations) return;
  if ((await planUsage(db, tenantId)).activeLocations >= limits.includedLocations) {
    throw new AppError(402, 'plan_limit_locations', 'This plan includes one location');
  }
}

/** 402 when the plan doesn't allow another active person/space/table (Individual: one). */
export async function assertCanAddResource(db: Q, tenantId: string) {
  const limit = PLAN_LIMITS[await planOf(db, tenantId)].maxResources;
  if (limit == null) return;
  if ((await planUsage(db, tenantId)).activeResources >= limit) {
    throw new AppError(402, 'plan_limit_resources', `This plan includes ${limit} agenda`);
  }
}

/** 402 when the owner can't open another business (a free business can't have siblings). */
export async function assertCanAddBusiness(db: Pick<Db, 'select'>, userId: string) {
  const owned = await db
    .select({ plan: tenants.plan })
    .from(memberships)
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(and(eq(memberships.userId, userId), eq(memberships.role, 'owner')));
  if (owned.some((t) => !PLAN_LIMITS[t.plan].extraBusinesses)) {
    throw new AppError(402, 'plan_limit_businesses', 'The free plan includes one business');
  }
}

/** Is this business an additional one of its owner (billed as an add-on)? */
async function isExtraBusiness(db: Q, tenantId: string): Promise<boolean> {
  const res = await db.execute<{ n: string }>(sql`
    select count(*) as n from memberships m
    join memberships o on o.user_id = m.user_id and o.role = 'owner'
    join tenants t on t.id = o.tenant_id
    where m.tenant_id = ${tenantId} and m.role = 'owner' and t.created_at < (select created_at from tenants where id = ${tenantId})`);
  return num(res.rows[0]?.n) > 0;
}

export async function planInfo(db: Q, tenantId: string, billingConnected: boolean): Promise<PlanInfoDto> {
  const plan = await planOf(db, tenantId);
  const b = (
    await db.execute<{ status: BillingStatus; pending_plan: PlanId | null; amount: number | null; since: string | null }>(sql`
      select billing_status as status, billing_pending_plan as pending_plan, billing_amount_cents as amount,
             billing_past_due_since as since from tenants where id = ${tenantId}`)
  ).rows[0];
  const since = b?.since ? new Date(b.since) : null;
  const limits = PLAN_LIMITS[plan];
  const usage = await planUsage(db, tenantId);
  const extraLocations = Math.max(0, usage.activeLocations - limits.includedLocations);
  const extraBusiness = plan !== 'free' && (await isExtraBusiness(db, tenantId));
  const base = extraBusiness ? ADDON_PRICES.extraBusinessCents : limits.priceCents;
  return {
    plan,
    limits,
    usage,
    extraLocations,
    extraBusiness,
    monthlyTotalCents: base == null ? null : base + extraLocations * ADDON_PRICES.extraLocationCents,
    billingConnected,
    billing: {
      status: b?.status ?? 'none',
      pendingPlan: b?.pending_plan ?? null,
      amountCents: b?.amount == null ? null : Number(b.amount),
      pastDueSince: since?.toISOString() ?? null,
      readOnly: isReadOnly({ billingStatus: b?.status ?? 'none', billingPastDueSince: since }),
    },
  };
}

/** 402 when moving to `plan` would leave the business over its limits (e.g. back to Free). */
export async function assertFitsPlan(db: Q, tenantId: string, plan: PlanId) {
  const limits = PLAN_LIMITS[plan];
  const usage = await planUsage(db, tenantId);
  if (limits.maxCustomers != null && usage.customers > limits.maxCustomers) {
    throw new AppError(402, 'plan_limit_customers', `This plan includes up to ${limits.maxCustomers} customers`);
  }
  if (!limits.extraLocations && usage.activeLocations > limits.includedLocations) {
    throw new AppError(402, 'plan_limit_locations', 'This plan includes one location');
  }
  if (limits.maxResources != null && usage.activeResources > limits.maxResources) {
    throw new AppError(402, 'plan_limit_resources', `This plan includes ${limits.maxResources} agenda`);
  }
}
