import { Hono } from 'hono';
import { eq, sql, type SQL } from 'drizzle-orm';
import { DateTime } from 'luxon';
import {
  reportQuerySchema,
  type AppointmentSource,
  type PaymentMethod,
  type PosKpis,
  type PosReport,
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
  if (q.resourceId) parts.push(sql`and a.resource_id = ${q.resourceId}`);
  if (q.locationId) parts.push(sql`and a.location_id = ${q.locationId}`);
  if (q.source) parts.push(sql`and a.source = ${q.source}`);
  return parts.length ? sql.join(parts, sql` `) : sql``;
}

/**
 * Payments that count as income. Paying with a gift card is not new money (it was counted when
 * the card was sold), so those are left out everywhere in the reports.
 */
function paymentFilter(q: ReportQuery, f: SQL): SQL {
  const notGift = sql`and p.method <> 'gift_card'`;
  if (!q.serviceId && !q.staffUserId && !q.resourceId && !q.source && !q.locationId) return notGift;
  return sql`${notGift} and exists (select 1 from appointments a where a.id = p.appointment_id and a.tenant_id = p.tenant_id ${f})`;
}

async function kpis(db: Db, tenantId: string, q: ReportQuery, r: Range): Promise<ReportKpis> {
  const F = r.start.toUTC().toISO()!;
  const T = r.end.toUTC().toISO()!;
  const f = filters(q);
  const [pay, appt, cust] = await Promise.all([
    db.execute(sql`
      select coalesce(sum(p.amount_cents), 0) as revenue, count(*) as payments,
             coalesce(sum(p.amount_cents) filter (where p.customer_plan_id is not null or p.sold_gift_card_id is not null or p.sale_id is not null), 0) as sales
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
    salesCents: n(p.sales),
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

// ---------- Point of sale ----------

/** Sales lines with their product's current cost and category (free lines have no product). */
const saleLines = (tenantId: string, F: string, T: string, loc: SQL) => sql`
  select s.id as sale_id, s.created_at, (i->>'productId') as product_id, i->>'name' as name,
         (i->>'qty')::int as qty, (i->>'totalCents')::int as total, pr.cost_cents, pr.category
  from sales s
  cross join lateral jsonb_array_elements(s.items) i
  left join products pr on pr.id = nullif(i->>'productId', '')::uuid and pr.tenant_id = s.tenant_id
  where s.tenant_id = ${tenantId} and s.status = 'paid'
    and s.created_at >= ${F}::timestamptz and s.created_at < ${T}::timestamptz ${loc}`;

async function posKpis(db: Db, tenantId: string, r: Range, loc: SQL): Promise<PosKpis> {
  const F = r.start.toUTC().toISO()!;
  const T = r.end.toUTC().toISO()!;
  const res = await db.execute(sql`
    with l as (${saleLines(tenantId, F, T, loc)})
    select count(distinct sale_id) as sales, coalesce(sum(total), 0) as revenue, coalesce(sum(qty) filter (where product_id is not null), 0) as units,
           coalesce(sum(total - qty * cost_cents) filter (where cost_cents is not null), 0) as profit,
           coalesce(sum(total) filter (where cost_cents is not null), 0) as costed,
           coalesce(sum(total) filter (where product_id is not null), 0) as products
    from l`);
  const x = res.rows[0] ?? {};
  const sales = n(x.sales);
  return {
    sales,
    revenueCents: n(x.revenue),
    avgTicketCents: sales ? Math.round(n(x.revenue) / sales) : 0,
    units: n(x.units),
    profitCents: n(x.profit),
    costCoverage: n(x.products) ? n(x.costed) / n(x.products) : 0,
  };
}

async function posSeries(db: Db, tenantId: string, tz: string, r: Range, g: ReportGranularity, loc: SQL) {
  const F = r.start.toUTC().toISO()!;
  const T = r.end.toUTC().toISO()!;
  const step = `1 ${g}`;
  const res = await db.execute(sql`
    with b as (
      select generate_series(
        date_trunc(${g}::text, ${F}::timestamptz at time zone ${tz}),
        date_trunc(${g}::text, (${T}::timestamptz - interval '1 second') at time zone ${tz}),
        ${step}::interval) as bucket),
    sv as (
      select date_trunc(${g}::text, s.created_at at time zone ${tz}) as bucket, count(*) as sales, sum(s.total_cents) as revenue
      from sales s where s.tenant_id = ${tenantId} and s.status = 'paid'
        and s.created_at >= ${F}::timestamptz and s.created_at < ${T}::timestamptz ${loc}
      group by 1)
    select to_char(b.bucket, 'YYYY-MM-DD') as bucket, coalesce(sv.revenue, 0) as revenue, coalesce(sv.sales, 0) as sales
    from b left join sv using (bucket) order by b.bucket`);
  return res.rows.map((x) => ({ bucket: String(x.bucket), revenueCents: n(x.revenue), sales: n(x.sales) }));
}

async function posReport(db: Db, tenantId: string, tz: string, q: ReportQuery, cur: Range, prev: Range, g: ReportGranularity): Promise<PosReport | null> {
  // Booking filters don't apply to counter sales: leave them out rather than show unfiltered numbers
  if (q.serviceId || q.staffUserId || q.resourceId || q.source) return null;
  const sells = await db.execute(sql`
    select exists (select 1 from products where tenant_id = ${tenantId}) or exists (select 1 from sales where tenant_id = ${tenantId}) as yes`);
  if (!sells.rows[0]?.yes) return null;
  const loc = q.locationId ? sql`and s.location_id = ${q.locationId}` : sql``;
  const F = cur.start.toUTC().toISO()!;
  const T = cur.end.toUTC().toISO()!;
  const [k, pk, s, ps, top, cat, meth] = await Promise.all([
    posKpis(db, tenantId, cur, loc),
    posKpis(db, tenantId, prev, loc),
    posSeries(db, tenantId, tz, cur, g, loc),
    posSeries(db, tenantId, tz, prev, g, loc),
    db.execute(sql`
      with l as (${saleLines(tenantId, F, T, loc)})
      select product_id, min(name) as name, sum(qty) as units, sum(total) as revenue,
             case when bool_and(cost_cents is not null) then sum(total - qty * cost_cents) end as profit
      from l group by product_id, case when product_id is null then name end
      order by revenue desc limit 10`),
    db.execute(sql`
      with l as (${saleLines(tenantId, F, T, loc)})
      select case when product_id is null then null else coalesce(category, '') end as category, sum(qty) as units, sum(total) as revenue
      from l group by 1 order by revenue desc`),
    db.execute(sql`
      select p.method, sum(p.amount_cents) as revenue from payments p join sales s on s.id = p.sale_id
      where p.tenant_id = ${tenantId} and s.status = 'paid'
        and s.created_at >= ${F}::timestamptz and s.created_at < ${T}::timestamptz ${loc}
      group by p.method order by revenue desc`),
  ]);
  return {
    kpis: k,
    previousKpis: pk,
    series: s,
    previousSeries: ps,
    topProducts: top.rows.map((x) => ({
      productId: x.product_id ? String(x.product_id) : null,
      name: String(x.name),
      units: n(x.units),
      revenueCents: n(x.revenue),
      profitCents: x.profit == null ? null : n(x.profit),
    })),
    // null = free lines (services without booking); '' = products without category
    byCategory: cat.rows.map((x) => ({ category: x.category == null ? null : String(x.category), units: n(x.units), revenueCents: n(x.revenue) })),
    byMethod: meth.rows.map((x) => ({ method: x.method as PaymentMethod, revenueCents: n(x.revenue) })),
  };
}

reportRoutes.get('/reports', async (c) => {
  const tenantId = c.get('tenantId');
  const q = reportQuerySchema.parse(c.req.query());
  const db = getDb();
  // Team members only get their own numbers, whatever filter they send.
  const scope = await getScope(db, c);
  if (scope.locationId) q.locationId = scope.locationId;
  if (scope.personal) {
    q.staffUserId = scope.resourceId ? undefined : scope.userId;
    q.resourceId = scope.resourceId ?? undefined;
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

  const [k, pk, s, ps, svc, method, source, weekday, heat, top, res, loc, pos] = await Promise.all([
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
      where c.tenant_id = ${tenantId} and p.status = 'paid' and c.notes is distinct from '__venta_mostrador__'
        and p.paid_at >= ${F}::timestamptz and p.paid_at < ${T}::timestamptz ${paymentFilter(q, f)}
      group by c.id order by total desc limit 10`),
    db.execute(sql`
      select r.id, r.name, r.color, count(a.id) as count, coalesce(sum(a.price_cents), 0) as revenue
      from appointments a join resources r on r.id = a.resource_id and r.tenant_id = a.tenant_id
      where a.tenant_id = ${tenantId} and a.status = 'completed'
        and a.starts_at >= ${F}::timestamptz and a.starts_at < ${T}::timestamptz ${f}
      group by r.id order by revenue desc, r.name`),
    db.execute(sql`
      select l.id, l.name, count(a.id) as count, coalesce(sum(a.price_cents), 0) as revenue
      from appointments a join locations l on l.id = a.location_id and l.tenant_id = a.tenant_id
      where a.tenant_id = ${tenantId} and a.status = 'completed'
        and a.starts_at >= ${F}::timestamptz and a.starts_at < ${T}::timestamptz ${f}
      group by l.id order by revenue desc, l.name`),
    posReport(db, tenantId, tz, q, cur, prev, g),
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
    byResource: res.rows.map((r) => ({ id: String(r.id), name: String(r.name), color: String(r.color), count: n(r.count), revenueCents: n(r.revenue) })),
    byLocation: loc.rows.map((r) => ({ id: String(r.id), name: String(r.name), count: n(r.count), revenueCents: n(r.revenue) })),
    byMethod: method.rows.map((r) => ({ method: r.method as PaymentMethod, count: n(r.count), revenueCents: n(r.revenue) })),
    bySource: source.rows.map((r) => ({ source: r.source as AppointmentSource, count: n(r.count) })),
    byWeekday: weekday.rows.map((r) => ({ weekday: n(r.weekday), count: n(r.count) })),
    heatmap: heat.rows.map((r) => ({ weekday: n(r.weekday), hour: n(r.hour), count: n(r.count) })),
    topCustomers: top.rows.map((r) => ({ id: String(r.id), name: String(r.name), visits: n(r.visits), totalSpentCents: n(r.total) })),
    pos,
  };
  return c.json(body);
});
