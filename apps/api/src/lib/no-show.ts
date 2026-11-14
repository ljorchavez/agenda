/**
 * Which upcoming bookings may not show up, from the customer's own history and how the booking
 * was made (statistics, no AI). Shown on the agenda so the business can reconfirm or ask a deposit.
 */
import { inArray, sql } from 'drizzle-orm';
import type { AppointmentDto, NoShowRiskDto } from '@agenda/shared';
import type { Db } from '../db/client.js';
import { appointments } from '../db/schema.js';

export type RiskInput = {
  /** Past bookings that ended (attended or not) */
  past: number;
  noShows: number;
  /** Booked online, the first time, with nothing paid */
  firstOnlineUnpaid: boolean;
  /** Days between booking and the appointment */
  leadDays: number;
  confirmed: boolean;
};

/** Points per reason; 3+ is high, 2 is medium. */
export function noShowRisk(i: RiskInput): NoShowRiskDto | null {
  const reasons: NoShowRiskDto['reasons'] = [];
  let points = 0;
  // Someone who misses now and then over many visits is not a risk; a habit is
  const rate = i.past ? i.noShows / i.past : 0;
  if (i.noShows > 0 && (i.past <= 3 || rate >= 0.25)) {
    points += 2;
    reasons.push('past_no_shows');
    if (i.noShows >= 2 && rate >= 0.4) points += 1;
  }
  if (i.firstOnlineUnpaid) {
    points += 1;
    reasons.push('first_visit');
  }
  if (i.leadDays >= 21) {
    points += 1;
    reasons.push('booked_far');
  }
  if (i.confirmed) points -= 1;
  if (points >= 3) return { level: 'high', reasons, noShows: i.noShows, past: i.past };
  if (points >= 2) return { level: 'medium', reasons, noShows: i.noShows, past: i.past };
  return null;
}

/** Adds the risk to the upcoming, still open bookings of a list. */
export async function withNoShowRisk(db: Db, tenantId: string, rows: AppointmentDto[]): Promise<AppointmentDto[]> {
  const now = Date.now();
  const open = rows.filter((a) => new Date(a.startsAt).getTime() > now && (a.status === 'scheduled' || a.status === 'confirmed'));
  if (!open.length) return rows;
  const customerIds = [...new Set(open.map((a) => a.customerId))];
  const stats = await db.execute<{ customer_id: string; past: string; no_shows: string }>(sql`
    select customer_id, count(*) filter (where status in ('completed', 'no_show')) as past,
           count(*) filter (where status = 'no_show') as no_shows
    from appointments
    where tenant_id = ${tenantId} and starts_at < now() and customer_id in (${sql.join(customerIds.map((id) => sql`${id}`), sql`, `)})
    group by customer_id`);
  const byCustomer = new Map(stats.rows.map((r) => [r.customer_id, { past: Number(r.past), noShows: Number(r.no_shows) }]));
  const created = await db.select({ id: appointments.id, createdAt: appointments.createdAt }).from(appointments).where(inArray(appointments.id, open.map((a) => a.id)));
  const createdAt = new Map(created.map((r) => [r.id, r.createdAt.getTime()]));
  const risk = new Map<string, NoShowRiskDto | null>();
  for (const a of open) {
    const s = byCustomer.get(a.customerId) ?? { past: 0, noShows: 0 };
    const start = new Date(a.startsAt).getTime();
    risk.set(
      a.id,
      noShowRisk({
        past: s.past,
        noShows: s.noShows,
        firstOnlineUnpaid: s.past === 0 && a.source === 'online' && a.paidCents === 0,
        leadDays: (start - (createdAt.get(a.id) ?? start)) / 86_400_000,
        confirmed: a.status === 'confirmed',
      }),
    );
  }
  return rows.map((a) => (risk.has(a.id) ? { ...a, noShowRisk: risk.get(a.id) ?? null } : a));
}
