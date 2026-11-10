import { Hono } from 'hono';
import { and, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  paymentCreateSchema,
  paymentLinkSchema,
  paymentSettingsOf,
  PAYMENT_STATUSES,
} from '@agenda/shared';
import { getDb } from '../db/client.js';
import { appointments, customers, locations, memberships, payments, services, tenants } from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import { apiBaseUrl, createOnlinePayment } from '../lib/online-payments.js';
import { toPaymentDto } from '../lib/mappers.js';
import { forbiddenScope, getScope, inScope, paymentScopeSql } from '../lib/access.js';
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

  let tenantIds = [tenantId];
  if (c.req.query('all') === '1') {
    const managed = await db
      .select({ t: memberships.tenantId })
      .from(memberships)
      .where(and(eq(memberships.userId, c.get('userId')), inArray(memberships.role, ['owner', 'admin']), isNull(memberships.locationId)));
    if (managed.length) tenantIds = managed.map((m) => m.t);
  }
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

/** Registers a payment received outside the platform (cash, terminal, transfer). */
paymentRoutes.post('/payments', async (c) => {
  const input = paymentCreateSchema.parse(await c.req.json());
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
