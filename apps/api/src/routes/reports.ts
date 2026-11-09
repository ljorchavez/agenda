import { Hono } from 'hono';
import { eq, sql, type SQL } from 'drizzle-orm';
import { DateTime } from 'luxon';
import {
  reportQuerySchema,
  type AppointmentSource,
  type PaymentMethod,
  type ReportDto,
  type ReportGranularity,
  type ReportKpis,
  type ReportPoint,
  type ReportQuery,
} from '@agenda/shared';
import { getDb, type Db } from '../db/client.js';
import { tenants } from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import { getScope } from '../lib/access.js';
import type { AppEnv } from '../middleware/auth.js';

/**
 * Historical, filterable reports: any date range, day/week/month buckets,
 * optional service / staff / source filters and comparison with the previous period.
 * Every query is scoped by tenant_id.
 */
export const reportRoutes = new Hono<AppEnv>();

const n = (v: unknown) => Number(v ?? 0);
const MAX_DAYS = 366 * 3;

type Range = { start: DateTime; end: DateTime }; // [start, end) in tenant tz

/** Previous comparable period: same number of months if the range is whole months, else same number of days. */
export function previousRange({ start, end }: Range): Range {
  const lastDay = end.minus({ days: 1 });
  const wholeMonths = start.day === 1 && lastDay.plus({ days: 1 }).day === 1;
  if (wholeMonths) {
    const months = Math.round(end.diff(start, 'months').months);
    return { start: start.minus({ months }), end: start };
  }
  const days = Math.round(end.diff(start, 'days').days);
  return { start: start.minus({ days }), end: start };
}

export function defaultGranularity(days: number): ReportGranularity {
  if (days <= 31) return 'day';
  if (days <= 190) return 'week';
  return 'month';
}

function filters(q: ReportQuery): SQL {
  const parts: SQL[] = [];
  if (q.serviceId) parts.push(sql`and a.service_id = ${q.serviceId}`);
  if (q.staffUserId) parts.push(sql`and a.staff_user_id = ${q.staffUserId}`);
  if (q.professionalId) parts.push(sql`and a.professional_id = ${q.professionalId}`);
  if (q.spaceId) parts.push(sql`and a.space_id = ${q.spaceId}`);
  if (q.source) parts.push(sql`and a.source = ${q.source}`);
  return parts.length ? sql.join(parts, sql` `) : sql``;
}

function paymentFilter(q: ReportQuery, f: SQL): SQL {
  if (!q.serviceId && !q.staffUserId && !q.professionalId && !q.spaceId && !q.source) return sql``;
  return sql`and exists (select 1 from appointments a where a.id = p.appointment_id and a.tenant_id = p.tenant_id ${f})`;
}

async function kpis(db: Db, tenantId: string, q: ReportQuery, r: Range): Promise<ReportKpis> {
  const F = r.start.toUTC().toISO()!;
  const T = r.end.toUTC().toISO()!;
  const f = filters(q);
  const [pay, appt, cust] = await Promise.all([
    db.execute(sql`
      select coalesce(sum(p.amount_cents), 0) as revenue, count(*) as payments
      from payments p where p.tenant_id = ${tenantId} and p.status = 'paid'
        and p.paid_at >= ${F}::timestamptz and p.paid_at < ${T}::timestamptz ${paymentFilter(q, f)}`),
    db.execute(sql`
      select count(*) as all_count,
             count(*) filter (where a.status <> 'cancelled') as total,
             count(*) filter (where a.status = 'completed') as completed,
             count(*) filter (where a.status = 'cancelled') as cancelled,
             count(*) filter (where a.status = 'no_show') as no_show,
             count(*) filter (where a.status <> 'cancelled' and a.source = 'online') as online,
             count(distinct a.customer_id) filter (where a.status = 'completed') as active,
             count(distinct a.customer_id) filter (where a.status = 'completed' and exists (
               select 1 from appointments b where b.tenant_id = a.tenant_id and b.customer_id = a.customer_id
                 and b.status = 'completed' and b.starts_at < ${F}::timestamptz)) as returning_customers
      from appointments a where a.tenant_id = ${tenantId}
        and a.starts_at >= ${F}::timestamptz and a.starts_at < ${T}::timestamptz ${f}`),
    db.execute(sql`
      select count(*) as new_customers from (
        select a.customer_id, min(a.starts_at) as first_at from appointments a
        where a.tenant_id = ${tenantId} and a.status <> 'cancelled' ${f}
        group by a.customer_id) t
      where first_at >= ${F}::timestamptz and first_at < ${T}::timestamptz`),
  ]);
  const p = pay.rows[0] ?? {};
  const a = appt.rows[0] ?? {};
  const revenue = n(p.revenue);
  const completed = n(a.completed);
  const noShows = n(a.no_show);
  const total = n(a.total);
  return {
    revenueCents: revenue,
    payments: n(p.payments),
    avgTicketCents: n(p.payments) > 0 ? Math.round(revenue / n(p.payments)) : 0,
    appointments: total,
    completed,
    cancelled: n(a.cancelled),
    noShows,
    noShowRate: completed + noShows > 0 ? noShows / (completed + noShows) : 0,
    cancellationRate: n(a.all_count) > 0 ? n(a.cancelled) / n(a.all_count) : 0,
    newCustomers: n(cust.rows[0]?.new_customers),
    activeCustomers: n(a.active),
    returningCustomers: n(a.returning_customers),
    onlineShare: total > 0 ? n(a.online) / total : 0,
  };
}

async function series(db: Db, tenantId: string, tz: string, q: ReportQuery, r: Range, g: ReportGranularity): Promise<ReportPoint[]> {
  const F = r.start.toUTC().toISO()!;
  const T = r.end.toUTC().toISO()!;
  const f = filters(q);
  const step = `1 ${g}`;
  const res = await db.execute(sql`
    with b as (
      select generate_series(
        date_trunc(${g}::text, ${F}::timestamptz at time zone ${tz}),
        date_trunc(${g}::text, (${T}::timestamptz - interval '1 second') at time zone ${tz}),
        ${step}::interval) as bucket),
    rev as (
      select date_trunc(${g}::text, p.paid_at at time zone ${tz}) as bucket, sum(p.amount_cents) as revenue
      from payments p where p.tenant_id = ${tenantId} and p.status = 'paid'
        and p.paid_at >= ${F}::timestamptz and p.paid_at < ${T}::timestamptz ${paymentFilter(q, f)}
      group by 1),
    ap as (
      select date_trunc(${g}::text, a.starts_at at time zone ${tz}) as bucket,
             count(*) filter (where a.status <> 'cancelled') as appointments,
             count(*) filter (where a.status = 'completed') as completed,
             count(*) filter (where a.status = 'no_show') as no_shows,
             count(*) filter (where a.status = 'cancelled') as cancelled
      from appointments a where a.tenant_id = ${tenantId}
        and a.starts_at >= ${F}::timestamptz and a.starts_at < ${T}::timestamptz ${f}
      group by 1),
    nc as (
      select date_trunc(${g}::text, first_at at time zone ${tz}) as bucket, count(*) as new_customers
      from (select a.customer_id, min(a.starts_at) as first_at from appointments a
            where a.tenant_id = ${tenantId} and a.status <> 'cancelled' ${f} group by a.customer_id) t
      where first_at >= ${F}::timestamptz and first_at < ${T}::timestamptz
      group by 1)
    select to_char(b.bucket, 'YYYY-MM-DD') as bucket,
           coalesce(rev.revenue, 0) as revenue, coalesce(ap.appointments, 0) as appointments,
           coalesce(ap.completed, 0) as completed, coalesce(ap.no_shows, 0) as no_shows,
           coalesce(ap.cancelled, 0) as cancelled, coalesce(nc.new_customers, 0) as new_customers
    from b left join rev using (bucket) left join ap using (bucket) left join nc using (bucket)
    order by b.bucket`);
  return res.rows.map((x) => ({
    bucket: String(x.bucket),
    revenueCents: n(x.revenue),
    appointments: n(x.appointments),
    completed: n(x.completed),
    noShows: n(x.no_shows),
    cancelled: n(x.cancelled),
    newCustomers: n(x.new_customers),
  }));
}

reportRoutes.get('/reports', async (c) => {
  const tenantId = c.get('tenantId');
  const q = reportQuerySchema.parse(c.req.query());
  const db = getDb();
  // Team members only get their own numbers, whatever filter they send.
  const scope = await getScope(db, c);
  if (!scope.all) {
    q.staffUserId = scope.professionalId ? undefined : scope.userId;
    q.professionalId = scope.professionalId ?? undefined;
    q.spaceId = undefined;
  }
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw notFound('tenant');
  const tz = tenant.timezone;

  const start = DateTime.fromISO(q.from, { zone: tz }).startOf('day');
  const end = DateTime.fromISO(q.to, { zone: tz }).startOf('day').plus({ days: 1 });
  if (!start.isValid || !end.isValid) throw new AppError(422, 'invalid_range');
  const days = Math.round(end.diff(start, 'days').days);
  if (days > MAX_DAYS) throw new AppError(422, 'range_too_long', `Max ${MAX_DAYS} days`);
  const g = q.granularity ?? defaultGranularity(days);
  if (g === 'day' && days > 400) throw new AppError(422, 'range_too_long', 'Use week or month for long ranges');

  const cur: Range = { start, end };
  const prev = previousRange(cur);
  const F = start.toUTC().toISO()!;
  const T = end.toUTC().toISO()!;
  const f = filters(q);

  const [k, pk, s, ps, svc, method, source, weekday, heat, top, pro, spc] = await Promise.all([
    kpis(db, tenantId, q, cur),
    kpis(db, tenantId, q, prev),
    series(db, tenantId, tz, q, cur, g),
    series(db, tenantId, tz, q, prev, g),
    db.execute(sql`
      select s.id, s.name, count(a.id) as count, coalesce(sum(a.price_cents), 0) as revenue
      from appointments a join services s on s.id = a.service_id and s.tenant_id = a.tenant_id
      where a.tenant_id = ${tenantId} and a.status = 'completed'
        and a.starts_at >= ${F}::timestamptz and a.starts_at < ${T}::timestamptz ${f}
      group by s.id order by count desc, s.name`),
    db.execute(sql`
      select p.method, count(*) as count, coalesce(sum(p.amount_cents), 0) as revenue
      from payments p where p.tenant_id = ${tenantId} and p.status = 'paid'
        and p.paid_at >= ${F}::timestamptz and p.paid_at < ${T}::timestamptz ${paymentFilter(q, f)}
      group by p.method order by revenue desc`),
    db.execute(sql`
      select a.source, count(*) as count from appointments a
      where a.tenant_id = ${tenantId} and a.status <> 'cancelled'
        and a.starts_at >= ${F}::timestamptz and a.starts_at < ${T}::timestamptz ${f}
      group by a.source`),
    db.execute(sql`
      select extract(isodow from a.starts_at at time zone ${tz})::int as weekday, count(*) as count
      from appointments a where a.tenant_id = ${tenantId} and a.status <> 'cancelled'
        and a.starts_at >= ${F}::timestamptz and a.starts_at < ${T}::timestamptz ${f}
      group by 1 order by 1`),
    db.execute(sql`
      select extract(isodow from a.starts_at at time zone ${tz})::int as weekday,
             extract(hour from a.starts_at at time zone ${tz})::int as hour, count(*) as count
      from appointments a where a.tenant_id = ${tenantId} and a.status <> 'cancelled'
        and a.starts_at >= ${F}::timestamptz and a.starts_at < ${T}::timestamptz ${f}
      group by 1, 2`),
    db.execute(sql`
      select c.id, c.name, coalesce(sum(p.amount_cents), 0) as total,
        (select count(*) from appointments a where a.tenant_id = c.tenant_id and a.customer_id = c.id
           and a.status = 'completed' and a.starts_at >= ${F}::timestamptz and a.starts_at < ${T}::timestamptz ${f}) as visits
      from customers c join payments p on p.customer_id = c.id and p.tenant_id = c.tenant_id
      where c.tenant_id = ${tenantId} and p.status = 'paid'
        and p.paid_at >= ${F}::timestamptz and p.paid_at < ${T}::timestamptz ${paymentFilter(q, f)}
      group by c.id order by total desc limit 10`),
    db.execute(sql`
      select pr.id, pr.name, pr.color, count(a.id) as count, coalesce(sum(a.price_cents), 0) as revenue
      from appointments a join professionals pr on pr.id = a.professional_id and pr.tenant_id = a.tenant_id
      where a.tenant_id = ${tenantId} and a.status = 'completed'
        and a.starts_at >= ${F}::timestamptz and a.starts_at < ${T}::timestamptz ${f}
      group by pr.id order by revenue desc, pr.name`),
    db.execute(sql`
      select sp.id, sp.name, count(a.id) as count, coalesce(sum(a.price_cents), 0) as revenue
      from appointments a join spaces sp on sp.id = a.space_id and sp.tenant_id = a.tenant_id
      where a.tenant_id = ${tenantId} and a.status = 'completed'
        and a.starts_at >= ${F}::timestamptz and a.starts_at < ${T}::timestamptz ${f}
      group by sp.id order by revenue desc, sp.name`),
  ]);

  const body: ReportDto = {
    range: { from: q.from, to: q.to },
    previousRange: { from: prev.start.toISODate()!, to: prev.end.minus({ days: 1 }).toISODate()! },
    granularity: g,
    kpis: k,
    previousKpis: pk,
    series: s,
    previousSeries: ps,
    byService: svc.rows.map((r) => ({ id: String(r.id), name: String(r.name), count: n(r.count), revenueCents: n(r.revenue) })),
    byProfessional: pro.rows.map((r) => ({ id: String(r.id), name: String(r.name), color: String(r.color), count: n(r.count), revenueCents: n(r.revenue) })),
    bySpace: spc.rows.map((r) => ({ id: String(r.id), name: String(r.name), count: n(r.count), revenueCents: n(r.revenue) })),
    byMethod: method.rows.map((r) => ({ method: r.method as PaymentMethod, count: n(r.count), revenueCents: n(r.revenue) })),
    bySource: source.rows.map((r) => ({ source: r.source as AppointmentSource, count: n(r.count) })),
    byWeekday: weekday.rows.map((r) => ({ weekday: n(r.weekday), count: n(r.count) })),
    heatmap: heat.rows.map((r) => ({ weekday: n(r.weekday), hour: n(r.hour), count: n(r.count) })),
    topCustomers: top.rows.map((r) => ({ id: String(r.id), name: String(r.name), visits: n(r.visits), totalSpentCents: n(r.total) })),
  };
  return c.json(body);
});
