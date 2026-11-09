import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import {
  customerInputSchema,
  normalizeMxPhone,
  type CustomerWithStats,
} from '@agenda/shared';
import { getDb } from '../db/client.js';
import { customers } from '../db/schema.js';
import { conflict, notFound } from '../lib/errors.js';
import { toCustomerDto } from '../lib/mappers.js';
import { getScope, paymentScopeSql, scopeSql, type Scope } from '../lib/access.js';
import { requireManager, type AppEnv } from '../middleware/auth.js';

export const customerRoutes = new Hono<AppEnv>();

const SORTS = {
  name: sql`c.name asc`,
  recent: sql`c.created_at desc`,
  lastVisit: sql`v.last_visit desc nulls last`,
  totalSpent: sql`coalesce(p.total, 0) desc`,
  visits: sql`coalesce(v.visits, 0) desc`,
} as const;

type StatsRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  birthday: string | null;
  created_at: Date;
  visits: number | string;
  last_visit: Date | null;
  first_visit: Date | null;
  no_shows: number | string;
  total_spent: number | string;
  next_at: Date | null;
  total_count?: number | string;
};

function toStats(r: StatsRow): CustomerWithStats {
  const visits = Number(r.visits);
  const avg =
    visits >= 2 && r.first_visit && r.last_visit
      ? Math.round(
          (new Date(r.last_visit).getTime() - new Date(r.first_visit).getTime()) /
            86_400_000 /
            (visits - 1),
        )
      : null;
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    notes: r.notes,
    birthday: r.birthday,
    createdAt: new Date(r.created_at).toISOString(),
    visits,
    totalSpentCents: Number(r.total_spent),
    lastVisitAt: r.last_visit ? new Date(r.last_visit).toISOString() : null,
    nextAppointmentAt: r.next_at ? new Date(r.next_at).toISOString() : null,
    avgDaysBetweenVisits: avg,
    noShows: Number(r.no_shows),
  };
}

/**
 * Customers with visit/spend stats. Every subquery is scoped by tenant_id; for team members
 * the stats only count their own bookings, and (unless `anyCustomer`) only their customers are listed.
 */
function statsQuery(tenantId: string, opts: { customerId?: string; q?: string; scope?: Scope; anyCustomer?: boolean }) {
  const scope: Scope = opts.scope ?? { all: true, locationId: null, personal: false, userId: '', professionalId: null };
  const sc = scopeSql(scope, 'a');
  const filters = [sql`c.tenant_id = ${tenantId}`];
  if (!scope.all && !opts.anyCustomer) {
    filters.push(sql`exists (select 1 from appointments a where a.customer_id = c.id and a.tenant_id = c.tenant_id ${sc})`);
  }
  if (opts.customerId) filters.push(sql`c.id = ${opts.customerId}`);
  if (opts.q) {
    const like = `%${opts.q}%`;
    filters.push(sql`(c.name ilike ${like} or c.phone ilike ${like} or c.email ilike ${like})`);
  }
  return sql`
    select c.id, c.name, c.phone, c.email, c.notes, c.birthday, c.created_at,
      coalesce(v.visits, 0) as visits, v.last_visit, v.first_visit,
      coalesce(v.no_shows, 0) as no_shows,
      coalesce(p.total, 0) as total_spent,
      n.next_at,
      count(*) over () as total_count
    from customers c
    left join lateral (
      select count(*) filter (where a.status = 'completed') as visits,
             max(a.starts_at) filter (where a.status = 'completed') as last_visit,
             min(a.starts_at) filter (where a.status = 'completed') as first_visit,
             count(*) filter (where a.status = 'no_show') as no_shows
      from appointments a where a.customer_id = c.id and a.tenant_id = c.tenant_id ${sc}
    ) v on true
    left join lateral (
      select sum(pay.amount_cents) as total from payments pay
      where pay.customer_id = c.id and pay.tenant_id = c.tenant_id and pay.status = 'paid' ${paymentScopeSql(scope, 'pay')}
    ) p on true
    left join lateral (
      select min(a.starts_at) as next_at from appointments a
      where a.customer_id = c.id and a.tenant_id = c.tenant_id
        and a.starts_at > now() and a.status in ('scheduled', 'confirmed') ${sc}
    ) n on true
    where ${sql.join(filters, sql` and `)}`;
}

customerRoutes.get('/customers', async (c) => {
  const tenantId = c.get('tenantId');
  const q = c.req.query('q')?.trim() || undefined;
  const sortKey = (c.req.query('sort') ?? 'name') as keyof typeof SORTS;
  const sort = SORTS[sortKey] ?? SORTS.name;
  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query('offset')) || 0, 0);
  const db = getDb();
  const scope = await getScope(db, c);
  // The booking form may look up any customer by name/phone so a team member can book them.
  const anyCustomer = c.req.query('for') === 'booking' && Boolean(q);

  const res = await db.execute<StatsRow>(
    sql`${statsQuery(tenantId, { q, scope, anyCustomer })} order by ${sort} limit ${limit} offset ${offset}`,
  );
  return c.json({
    items: res.rows.map(toStats),
    total: Number(res.rows[0]?.total_count ?? 0),
  });
});

customerRoutes.get('/customers/:id', async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const db = getDb();
  const scope = await getScope(db, c);
  const res = await db.execute<StatsRow>(statsQuery(tenantId, { customerId: id, scope }));
  const row = res.rows[0];
  if (!row) throw notFound('customer');

  const history = await db.execute(sql`
    select a.id, a.starts_at, a.ends_at, a.status, a.price_cents, a.notes, a.source,
           s.name as service_name,
           coalesce((select sum(p.amount_cents) from payments p
                     where p.appointment_id = a.id and p.tenant_id = a.tenant_id
                       and p.status = 'paid'), 0) as paid_cents
    from appointments a join services s on s.id = a.service_id
    where a.tenant_id = ${tenantId} and a.customer_id = ${id} ${scopeSql(scope, 'a')}
    order by a.starts_at desc limit 100`);

  const payments = await db.execute(sql`
    select p.id, p.amount_cents, p.method, p.status, p.paid_at, p.created_at, p.appointment_id, p.notes
    from payments p where p.tenant_id = ${tenantId} and p.customer_id = ${id} ${paymentScopeSql(scope, 'p')}
    order by coalesce(paid_at, created_at) desc limit 100`);

  return c.json({
    ...toStats(row),
    appointments: history.rows.map((r: Record<string, unknown>) => ({
      id: r.id,
      startsAt: new Date(r.starts_at as string).toISOString(),
      endsAt: new Date(r.ends_at as string).toISOString(),
      status: r.status,
      priceCents: Number(r.price_cents),
      paidCents: Number(r.paid_cents),
      serviceName: r.service_name,
      notes: r.notes,
      source: r.source,
    })),
    payments: payments.rows.map((r: Record<string, unknown>) => ({
      id: r.id,
      amountCents: Number(r.amount_cents),
      method: r.method,
      status: r.status,
      paidAt: r.paid_at ? new Date(r.paid_at as string).toISOString() : null,
      createdAt: new Date(r.created_at as string).toISOString(),
      appointmentId: r.appointment_id,
      notes: r.notes,
    })),
  });
});

function normalize(input: ReturnType<typeof customerInputSchema.parse>) {
  return {
    name: input.name,
    phone: input.phone ? normalizeMxPhone(input.phone) : null,
    email: input.email || null,
    notes: input.notes ?? null,
    birthday: input.birthday ?? null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

customerRoutes.post('/customers', async (c) => {
  const input = customerInputSchema.parse(await c.req.json());
  try {
    const [row] = await getDb()
      .insert(customers)
      .values({ tenantId: c.get('tenantId'), ...normalize(input) })
      .returning();
    return c.json(toCustomerDto(row!), 201);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('phone_taken', 'A customer with this phone exists');
    throw err;
  }
});

customerRoutes.put('/customers/:id', async (c) => {
  const input = customerInputSchema.parse(await c.req.json());
  const db = getDb();
  const scope = await getScope(db, c);
  if (!scope.all) {
    const visible = await db.execute(statsQuery(c.get('tenantId'), { customerId: c.req.param('id'), scope }));
    if (!visible.rows.length) throw notFound('customer');
  }
  try {
    const [row] = await getDb()
      .update(customers)
      .set(normalize(input))
      .where(and(eq(customers.id, c.req.param('id')), eq(customers.tenantId, c.get('tenantId'))))
      .returning();
    if (!row) throw notFound('customer');
    return c.json(toCustomerDto(row));
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('phone_taken', 'A customer with this phone exists');
    throw err;
  }
});

customerRoutes.delete('/customers/:id', requireManager, async (c) => {
  const [row] = await getDb()
    .delete(customers)
    .where(and(eq(customers.id, c.req.param('id')), eq(customers.tenantId, c.get('tenantId'))))
    .returning({ id: customers.id });
  if (!row) throw notFound('customer');
  return c.body(null, 204);
});
