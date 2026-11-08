import { Hono } from 'hono';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { paymentCreateSchema, paymentLinkSchema, PAYMENT_STATUSES } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { appointments, customers, payments, services } from '../db/schema.js';
import { createCardCheckout, createSpeiOrder } from '../integrations/mercadopago.js';
import { notFound } from '../lib/errors.js';
import { toPaymentDto } from '../lib/mappers.js';
import type { AppEnv } from '../middleware/auth.js';

export const paymentRoutes = new Hono<AppEnv>();

paymentRoutes.get('/payments', async (c) => {
  const tenantId = c.get('tenantId');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const customerId = c.req.query('customerId');
  const filters = [eq(payments.tenantId, tenantId)];
  const when = sql`coalesce(${payments.paidAt}, ${payments.createdAt})`;
  if (from) filters.push(gte(when, new Date(from)));
  if (to) filters.push(lt(when, new Date(to)));
  if (customerId) filters.push(eq(payments.customerId, customerId));

  const rows = await getDb()
    .select({ p: payments, customerName: customers.name })
    .from(payments)
    .innerJoin(customers, eq(customers.id, payments.customerId))
    .where(and(...filters))
    .orderBy(desc(sql`coalesce(${payments.paidAt}, ${payments.createdAt})`))
    .limit(500);
  return c.json(rows.map((r) => toPaymentDto({ ...r.p, customerName: r.customerName })));
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
  if (input.appointmentId) {
    const appt = await db.query.appointments.findFirst({
      where: and(eq(appointments.id, input.appointmentId), eq(appointments.tenantId, tenantId)),
    });
    if (!appt) throw notFound('appointment');
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

paymentRoutes.patch('/payments/:id', async (c) => {
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

  const [pending] = await db
    .insert(payments)
    .values({
      tenantId,
      customerId: appt.customer.id,
      appointmentId: appt.a.id,
      amountCents: input.amountCents,
      method: input.method,
      status: 'pending',
      provider: 'mercadopago',
    })
    .returning();

  const apiBase = process.env.PUBLIC_API_URL ?? `${new URL(c.req.url).origin}/api`;
  const params = {
    paymentId: pending!.id,
    title: appt.serviceName,
    amountCents: input.amountCents,
    payerEmail: appt.customer.email,
    notificationUrl: `${apiBase}/webhooks/mercadopago`,
    backUrl: process.env.APP_URL ?? 'http://localhost:5173',
  };

  try {
    const result =
      input.method === 'spei' ? await createSpeiOrder(params) : await createCardCheckout(params);
    const [row] = await db
      .update(payments)
      .set({ providerRef: result.providerRef, checkoutUrl: result.checkoutUrl })
      .where(eq(payments.id, pending!.id))
      .returning();
    return c.json(toPaymentDto(row!), 201);
  } catch (err) {
    await db.update(payments).set({ status: 'failed' }).where(eq(payments.id, pending!.id));
    throw err;
  }
});
