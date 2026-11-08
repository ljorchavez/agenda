import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { AppointmentStatus, DashboardDto } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { tenants } from '../db/schema.js';
import { queryAppointments } from '../lib/appointments.js';
import { notFound } from '../lib/errors.js';
import type { AppEnv } from '../middleware/auth.js';

export const metricsRoutes = new Hono<AppEnv>();

const n = (v: unknown) => Number(v ?? 0);

/**
 * Dashboard metrics for [from, to). Defaults to the current month in the tenant's timezone.
 * All queries are filtered by tenant_id.
 */
metricsRoutes.get('/metrics/dashboard', async (c) => {
  const tenantId = c.get('tenantId');
  const db = getDb();
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw notFound('tenant');
  const tz = tenant.timezone;

  const now = DateTime.now().setZone(tz);
  const from = c.req.query('from')
    ? DateTime.fromISO(c.req.query('from')!, { zone: tz })
    : now.startOf('month');
  const to = c.req.query('to')
    ? DateTime.fromISO(c.req.query('to')!, { zone: tz })
    : from.plus({ months: 1 }).startOf('month');
  const spanMs = to.toMillis() - from.toMillis();
  const prevFrom = from.minus({ milliseconds: spanMs });
  const F = from.toUTC().toISO()!;
  const T = to.toUTC().toISO()!;
  const PF = prevFrom.toUTC().toISO()!;
  const sixMonthsAgo = to.minus({ months: 6 }).startOf('month').toUTC().toISO()!;

  const [kpiRes, prevRes, apptRes, customerRes, freqRes, monthRes, statusRes, weekdayRes, topCustRes, topSvcRes, upcoming] =
    await Promise.all([
      db.execute(sql`
        select coalesce(sum(amount_cents), 0) as revenue, count(*) as payments
        from payments where tenant_id = ${tenantId} and status = 'paid'
          and paid_at >= ${F} and paid_at < ${T}`),
      db.execute(sql`
        select coalesce(sum(amount_cents), 0) as revenue
        from payments where tenant_id = ${tenantId} and status = 'paid'
          and paid_at >= ${PF} and paid_at < ${F}`),
      db.execute(sql`
        select count(*) filter (where status <> 'cancelled') as total,
               count(*) filter (where status = 'completed') as completed,
               count(*) filter (where status = 'no_show') as no_show,
               count(distinct customer_id) filter (where status = 'completed') as active_customers
        from appointments where tenant_id = ${tenantId}
          and starts_at >= ${F} and starts_at < ${T}`),
      db.execute(sql`
        select count(*) as new_customers from customers
        where tenant_id = ${tenantId} and created_at >= ${F} and created_at < ${T}`),
      db.execute(sql`
        select avg(span_days / (visits - 1)) as avg_days from (
          select extract(epoch from max(starts_at) - min(starts_at)) / 86400 as span_days,
                 count(*) as visits
          from appointments where tenant_id = ${tenantId} and status = 'completed'
          group by customer_id having count(*) >= 2) t`),
      db.execute(sql`
        with months as (
          select generate_series(
            date_trunc('month', ${sixMonthsAgo}::timestamptz at time zone ${tz}),
            date_trunc('month', (${T}::timestamptz - interval '1 second') at time zone ${tz}),
            interval '1 month') as m)
        select to_char(m, 'YYYY-MM') as month,
          coalesce((select sum(amount_cents) from payments p
                    where p.tenant_id = ${tenantId} and p.status = 'paid'
                      and date_trunc('month', p.paid_at at time zone ${tz}) = m), 0) as revenue,
          coalesce((select count(*) from appointments a
                    where a.tenant_id = ${tenantId} and a.status = 'completed'
                      and date_trunc('month', a.starts_at at time zone ${tz}) = m), 0) as appointments
        from months order by m`),
      db.execute(sql`
        select status, count(*) as count from appointments
        where tenant_id = ${tenantId} and starts_at >= ${F} and starts_at < ${T}
        group by status`),
      db.execute(sql`
        select extract(isodow from starts_at at time zone ${tz})::int as weekday, count(*) as count
        from appointments where tenant_id = ${tenantId} and status <> 'cancelled'
          and starts_at >= ${F} and starts_at < ${T}
        group by 1 order by 1`),
      db.execute(sql`
        select c.id, c.name,
          (select count(*) from appointments a where a.customer_id = c.id and a.tenant_id = c.tenant_id
             and a.status = 'completed' and a.starts_at >= ${F} and a.starts_at < ${T}) as visits,
          coalesce(sum(p.amount_cents), 0) as total
        from customers c join payments p on p.customer_id = c.id and p.tenant_id = c.tenant_id
        where c.tenant_id = ${tenantId} and p.status = 'paid' and p.paid_at >= ${F} and p.paid_at < ${T}
        group by c.id order by total desc limit 5`),
      db.execute(sql`
        select s.id, s.name, count(a.id) as count, coalesce(sum(a.price_cents), 0) as revenue
        from appointments a join services s on s.id = a.service_id
        where a.tenant_id = ${tenantId} and a.status = 'completed'
          and a.starts_at >= ${F} and a.starts_at < ${T}
        group by s.id order by count desc limit 5`),
      queryAppointments(
        db,
        tenantId,
        sql`a.starts_at >= now() and a.status in ('scheduled', 'confirmed')`,
        sql`order by a.starts_at asc limit 8`,
      ),
    ]);

  const k = kpiRes.rows[0] ?? {};
  const a = apptRes.rows[0] ?? {};
  const revenue = n(k.revenue);
  const completed = n(a.completed);
  const noShow = n(a.no_show);
  const avgDays = freqRes.rows[0]?.avg_days;

  const body: DashboardDto = {
    range: { from: from.toISO()!, to: to.toISO()! },
    kpis: {
      revenueCents: revenue,
      revenuePrevCents: n(prevRes.rows[0]?.revenue),
      appointments: n(a.total),
      completed,
      noShowRate: completed + noShow > 0 ? noShow / (completed + noShow) : 0,
      newCustomers: n(customerRes.rows[0]?.new_customers),
      activeCustomers: n(a.active_customers),
      avgTicketCents: n(k.payments) > 0 ? Math.round(revenue / n(k.payments)) : 0,
      avgDaysBetweenVisits: avgDays == null ? null : Math.round(Number(avgDays)),
    },
    revenueByMonth: monthRes.rows.map((r) => ({
      month: String(r.month),
      revenueCents: n(r.revenue),
      appointments: n(r.appointments),
    })),
    appointmentsByStatus: statusRes.rows.map((r) => ({
      status: r.status as AppointmentStatus,
      count: n(r.count),
    })),
    appointmentsByWeekday: weekdayRes.rows.map((r) => ({
      weekday: n(r.weekday),
      count: n(r.count),
    })),
    topCustomers: topCustRes.rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      visits: n(r.visits),
      totalSpentCents: n(r.total),
    })),
    topServices: topSvcRes.rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      count: n(r.count),
      revenueCents: n(r.revenue),
    })),
    upcoming,
  };
  return c.json(body);
});
