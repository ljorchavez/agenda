import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { CustomerPlanDto, PlanChoiceDto } from '@agenda/shared';
import type { Db } from '../db/client.js';
import { appointments, planUses, type Appointment } from '../db/schema.js';
import { AppError, notFound } from './errors.js';

type Q = Pick<Db, 'execute'>;

type PlanRow = {
  id: string;
  kind: 'package' | 'membership';
  name: string;
  service_ids: string[];
  sessions_total: number | null;
  price_cents: number;
  starts_on: string;
  expires_on: string | null;
  cancelled_at: Date | null;
  used: string | number;
};

const statusOf = (r: PlanRow, today: string): CustomerPlanDto['status'] => {
  if (r.cancelled_at) return 'cancelled';
  if (r.expires_on && r.expires_on < today) return 'expired';
  if (r.sessions_total != null && Number(r.used) >= r.sessions_total) return 'used_up';
  return 'active';
};

const dateStr = (d: unknown) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d));

/** Packages and memberships of a customer, newest first, with their uses. */
export async function customerPlans(db: Q, tenantId: string, customerId: string, today: string): Promise<CustomerPlanDto[]> {
  const res = await db.execute<PlanRow>(sql`
    select cp.id, cp.kind, cp.name, cp.service_ids, cp.sessions_total, cp.price_cents, cp.starts_on, cp.expires_on, cp.cancelled_at,
           coalesce((select sum(u.sessions) from plan_uses u where u.customer_plan_id = cp.id), 0) as used
    from customer_plans cp
    where cp.tenant_id = ${tenantId} and cp.customer_id = ${customerId}
    order by cp.starts_on desc, cp.created_at desc`);
  if (!res.rows.length) return [];
  const uses = await db.execute<{ plan_id: string; appointment_id: string; starts_at: Date; service_name: string; sessions: number }>(sql`
    select u.customer_plan_id as plan_id, u.appointment_id, a.starts_at, s.name as service_name, u.sessions
    from plan_uses u join appointments a on a.id = u.appointment_id join services s on s.id = a.service_id
    join customer_plans cp on cp.id = u.customer_plan_id
    where u.tenant_id = ${tenantId} and cp.customer_id = ${customerId}
    order by a.starts_at desc`);
  return res.rows.map((r) => {
    const used = Number(r.used);
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      serviceIds: r.service_ids ?? [],
      sessionsTotal: r.sessions_total,
      sessionsUsed: used,
      sessionsLeft: r.sessions_total == null ? null : Math.max(0, r.sessions_total - used),
      priceCents: r.price_cents,
      startsOn: dateStr(r.starts_on),
      expiresOn: r.expires_on ? dateStr(r.expires_on) : null,
      status: statusOf({ ...r, expires_on: r.expires_on ? dateStr(r.expires_on) : null }, today),
      uses: uses.rows
        .filter((u) => u.plan_id === r.id)
        .map((u) => ({ appointmentId: u.appointment_id, startsAt: new Date(u.starts_at).toISOString(), serviceName: u.service_name, sessions: u.sessions })),
    };
  });
}

/** Active plans that cover this booking's service on its day, with sessions left. */
export async function plansFor(db: Q, tenantId: string, appt: Pick<Appointment, 'customerId' | 'serviceId' | 'startsAt'>, tz: string): Promise<PlanChoiceDto[]> {
  const day = appt.startsAt.toLocaleDateString('en-CA', { timeZone: tz });
  const all = await customerPlans(db, tenantId, appt.customerId, day);
  return all
    .filter((p) => p.status !== 'cancelled' && p.startsOn <= day && (!p.expiresOn || p.expiresOn >= day))
    .filter((p) => p.sessionsLeft == null || p.sessionsLeft > 0)
    .filter((p) => !p.serviceIds.length || p.serviceIds.includes(appt.serviceId))
    .map((p) => ({ id: p.id, name: p.name, sessionsLeft: p.sessionsLeft, expiresOn: p.expiresOn }));
}

/**
 * Takes the booking's session(s) from a plan (a class booking with 2 spots takes 2). The booking
 * is then covered by the plan: its price moves to the discount, so nothing is owed for it.
 * `planId` null gives the session back and restores the price ("cobrar normal").
 */
export async function setPlanUse(tx: Db, tenantId: string, appt: Appointment, planId: string | null, tz: string, userId: string) {
  const existing = await tx.query.planUses.findFirst({ where: eq(planUses.appointmentId, appt.id) });
  const fullPrice = appt.priceCents + appt.discountCents;
  if (existing) {
    await tx.delete(planUses).where(eq(planUses.id, existing.id));
    await tx
      .update(appointments)
      .set({ priceCents: fullPrice, discountCents: 0, discountReason: null, updatedAt: new Date() })
      .where(eq(appointments.id, appt.id));
  }
  if (!planId) return;
  if (appt.status !== 'completed') throw new AppError(422, 'plan_needs_completed', 'Mark the booking as completed first');
  const choices = await plansFor(tx, tenantId, appt, tz);
  const plan = choices.find((p) => p.id === planId);
  if (!plan) throw notFound('plan');
  const sessions = appt.classSessionId ? Math.max(1, appt.partySize ?? 1) : 1;
  if (plan.sessionsLeft != null && plan.sessionsLeft < sessions) throw new AppError(422, 'plan_no_sessions', 'Not enough sessions left');
  await tx.insert(planUses).values({ tenantId, customerPlanId: planId, appointmentId: appt.id, sessions, createdBy: userId });
  await tx
    .update(appointments)
    .set({ priceCents: 0, discountCents: fullPrice, discountReason: 'package', couponId: null, updatedAt: new Date() })
    .where(and(eq(appointments.id, appt.id), eq(appointments.tenantId, tenantId)));
}

/** Gift card codes: 8 characters without look-alikes (0/O, 1/I). */
export function giftCardCode(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => abc[b % abc.length]).join('');
}
