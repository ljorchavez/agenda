import type { Context } from 'hono';
import { Hono } from 'hono';
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  collectionState,
  noShowOwes,
  ONLINE_METHODS,
  paymentCreateSchema,
  type CollectionDto,
  type PaymentMethod,
  type TenantSettings,
  paymentLinkSchema,
  paymentSettingsOf,
  PAYMENT_STATUSES,
} from '@agenda/shared';
import { getDb } from '../db/client.js';
import { appointments, customers, locations, memberships, payments, services, tenants } from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import { apiBaseUrl, createOnlinePayment } from '../lib/online-payments.js';
import { toPaymentDto } from '../lib/mappers.js';
import { forbiddenScope, getScope, inScope, paymentScopeSql, scopeSql } from '../lib/access.js';
import { requireManager, type AppEnv } from '../middleware/auth.js';

export const paymentRoutes = new Hono<AppEnv>();

/**
 * Payments in a date range. `all=1` lists every business where this login manages the whole
 * business (owners with several businesses see all their money in one list).
 */
paymentRoutes.get('/payments', async (c) => {
  const tenantId = c.get('tenantId');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const customerId = c.req.query('customerId');
  const db = getDb();
  const when = sql`coalesce(${payments.paidAt}, ${payments.createdAt})`;
  const filters = [];
  if (from) filters.push(gte(when, new Date(from)));
  if (to) filters.push(lt(when, new Date(to)));
  if (customerId) filters.push(eq(payments.customerId, customerId));

  const tenantIds = await listedTenants(c);
  if (tenantIds.length === 1 && tenantIds[0] === tenantId) {
    filters.push(eq(payments.tenantId, tenantId));
    const scope = await getScope(db, c);
    if (!scope.all) filters.push(sql`true ${paymentScopeSql(scope, 'payments')}`);
  } else {
    filters.push(inArray(payments.tenantId, tenantIds));
  }

  const rows = await db
    .select({
      p: payments,
      customerName: customers.name,
      businessName: tenants.name,
      locationId: appointments.locationId,
      locationName: locations.name,
      serviceName: services.name,
    })
    .from(payments)
    .innerJoin(customers, eq(customers.id, payments.customerId))
    .innerJoin(tenants, eq(tenants.id, payments.tenantId))
    .leftJoin(appointments, eq(appointments.id, payments.appointmentId))
    .leftJoin(locations, eq(locations.id, appointments.locationId))
    .leftJoin(services, eq(services.id, appointments.serviceId))
    .where(and(...filters))
    .orderBy(desc(when))
    .limit(5000); // the page warns when it gets exactly this many
  return c.json(
    rows.map((r) => ({
      ...toPaymentDto({ ...r.p, customerName: r.customerName }),
      tenantId: r.p.tenantId,
      businessName: r.businessName,
      locationId: r.locationId,
      locationName: r.locationName,
      serviceName: r.serviceName,
    })),
  );
});

/** Businesses this login may list together: all it manages whole when `all=1`, else the current one. */
async function listedTenants(c: Context<AppEnv>): Promise<string[]> {
  const tenantId = c.get('tenantId');
  if (c.req.query('all') !== '1') return [tenantId];
  const managed = await getDb()
    .select({ t: memberships.tenantId })
    .from(memberships)
    .where(and(eq(memberships.userId, c.get('userId')), inArray(memberships.role, ['owner', 'admin']), isNull(memberships.locationId)));
  return managed.length ? managed.map((m) => m.t) : [tenantId];
}

type CollectionRow = {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  service_name: string | null;
  resource_name: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  status: CollectionDto['status'];
  price_cents: number | string;
  paid_cents: number | string | null;
  methods: PaymentMethod[] | null;
  last_paid_at: Date | string | null;
  tenant_id: string;
  business_name: string;
  settings: TenantSettings;
  location_id: string;
  location_name: string | null;
};

/**
 * Cobros: every booking in the period with what it costs, what was paid and its state
 * (upcoming/past × unpaid/deposit/paid). If there's a booking, it's here, with or without payments.
 */
paymentRoutes.get('/collections', async (c) => {
  const from = new Date(c.req.query('from') ?? '');
  const to = new Date(c.req.query('to') ?? '');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    throw new AppError(422, 'validation_error', 'from/to required');
  }
  const db = getDb();
  const tenantId = c.get('tenantId');
  const tenantIds = await listedTenants(c);
  const onlyCurrent = tenantIds.length === 1 && tenantIds[0] === tenantId;
  const scope = await getScope(db, c);
  const res = await db.execute<CollectionRow>(sql`
    select a.id, a.customer_id, cu.name as customer_name, cu.phone as customer_phone,
           s.name as service_name, r.name as resource_name,
           a.starts_at, a.ends_at, a.status, a.price_cents,
           p.paid_cents, p.methods, p.last_paid_at,
           a.tenant_id, t.name as business_name, t.settings,
           a.location_id, l.name as location_name
    from appointments a
    join customers cu on cu.id = a.customer_id
    join tenants t on t.id = a.tenant_id
    left join services s on s.id = a.service_id
    left join resources r on r.id = a.resource_id
    left join locations l on l.id = a.location_id
    left join lateral (
      select sum(pp.amount_cents) as paid_cents,
             array_agg(distinct pp.method) as methods,
             max(pp.paid_at) as last_paid_at
      from payments pp
      where pp.appointment_id = a.id and pp.tenant_id = a.tenant_id and pp.status = 'paid'
    ) p on true
    where a.tenant_id in (${sql.join(tenantIds.map((id) => sql`${id}`), sql`, `)})
      and a.starts_at >= ${from.toISOString()} and a.starts_at < ${to.toISOString()}
      ${onlyCurrent ? scopeSql(scope, 'a') : sql``}
    order by a.starts_at desc
    limit 5000`);
  const now = new Date();
  const out: CollectionDto[] = [];
  for (const r of res.rows) {
    const priceCents = Number(r.price_cents);
    const paidCents = Number(r.paid_cents ?? 0);
    const owes = noShowOwes(r.settings ?? {});
    const state = collectionState({ priceCents, paidCents, status: r.status, endsAt: new Date(r.ends_at) }, { noShowOwes: owes, now });
    if (!state) continue;
    const due = r.status === 'no_show' && !owes ? paidCents : priceCents;
    out.push({
      appointmentId: r.id,
      customerId: r.customer_id,
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
      serviceName: r.service_name,
      resourceName: r.resource_name,
      startsAt: new Date(r.starts_at).toISOString(),
      endsAt: new Date(r.ends_at).toISOString(),
      status: r.status,
      priceCents,
      paidCents,
      balanceCents: Math.max(due - paidCents, 0),
      state,
      methods: r.methods ?? [],
      lastPaidAt: r.last_paid_at ? new Date(r.last_paid_at).toISOString() : null,
      tenantId: r.tenant_id,
      businessName: r.business_name,
      locationId: r.location_id,
      locationName: r.location_name,
    });
  }
  return c.json(out);
});

/** Registers a payment received outside the platform (cash, terminal, transfer). */
paymentRoutes.post('/payments', async (c) => {
  const input = paymentCreateSchema.parse(await c.req.json());
  // Mercado Pago (and SPEI through it) are recorded only by the platform when the money arrives.
  if ((ONLINE_METHODS as readonly string[]).includes(input.method)) {
    throw new AppError(422, 'online_method_manual', 'Mercado Pago payments are recorded automatically');
  }
  const tenantId = c.get('tenantId');
  const db = getDb();

  const customer = await db.query.customers.findFirst({
    where: and(eq(customers.id, input.customerId), eq(customers.tenantId, tenantId)),
  });
  if (!customer) throw notFound('customer');
  const scope = await getScope(db, c);
  // Team members record payments only for their own bookings.
  if (!scope.all && !input.appointmentId) throw forbiddenScope();
  if (input.appointmentId) {
    const appt = await db.query.appointments.findFirst({
      where: and(eq(appointments.id, input.appointmentId), eq(appointments.tenantId, tenantId)),
    });
    if (!appt) throw notFound('appointment');
    if (!inScope(scope, appt)) throw forbiddenScope();
  }

  const [row] = await db
    .insert(payments)
    .values({
      tenantId,
      customerId: customer.id,
      appointmentId: input.appointmentId ?? null,
      amountCents: input.amountCents,
      method: input.method,
      status: input.status,
      paidAt: input.status === 'paid' ? new Date(input.paidAt ?? Date.now()) : null,
      notes: input.notes ?? null,
    })
    .returning();
  return c.json(toPaymentDto({ ...row!, customerName: customer.name }), 201);
});

paymentRoutes.patch('/payments/:id', requireManager, async (c) => {
  const input = z.object({ status: z.enum(PAYMENT_STATUSES) }).parse(await c.req.json());
  const [row] = await getDb()
    .update(payments)
    .set({ status: input.status, paidAt: input.status === 'paid' ? new Date() : null })
    .where(and(eq(payments.id, c.req.param('id')), eq(payments.tenantId, c.get('tenantId'))))
    .returning();
  if (!row) throw notFound('payment');
  return c.json(toPaymentDto(row));
});

/**
 * Creates a Mercado Pago checkout (card) or SPEI order for an appointment deposit and
 * returns a URL to share with the customer. Status is updated by the webhook.
 */
paymentRoutes.post('/payments/link', async (c) => {
  const input = paymentLinkSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  const db = getDb();

  const [appt] = await db
    .select({ a: appointments, customer: customers, serviceName: services.name })
    .from(appointments)
    .innerJoin(customers, eq(customers.id, appointments.customerId))
    .innerJoin(services, eq(services.id, appointments.serviceId))
    .where(and(eq(appointments.id, input.appointmentId), eq(appointments.tenantId, tenantId)));
  if (!appt) throw notFound('appointment');
  if (!inScope(await getScope(db, c), appt.a)) throw forbiddenScope();

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw notFound('tenant');
  if (!paymentSettingsOf(tenant.settings).methods[input.method]) {
    throw new AppError(422, 'method_disabled', 'This payment method is disabled');
  }
  const row = await createOnlinePayment(db, tenant, {
    appointmentId: appt.a.id,
    customerId: appt.customer.id,
    customerEmail: appt.customer.email,
    title: appt.serviceName,
    amountCents: input.amountCents,
    method: input.method,
    apiBase: apiBaseUrl(c.req.url),
  });
  return c.json(toPaymentDto(row), 201);
});
