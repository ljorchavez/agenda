import { Hono } from 'hono';
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import {
  computeDepositCents,
  normalizeMxPhone,
  paymentSettingsOf,
  publicBookingSchema,
  type Locale,
  type PublicBookingResult,
  type PublicBusinessDto,
} from '@agenda/shared';
import { getDb } from '../db/client.js';
import { appointments, customers, services, tenants, type Tenant } from '../db/schema.js';
import { hasOverlap } from '../lib/appointments.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { apiBaseUrl, createOnlinePayment, tenantMpToken } from '../lib/online-payments.js';

/**
 * Unauthenticated endpoints for the public booking page (/b/:slug).
 * Only exposes the business name, hours and active services — never customer data.
 * In AWS, API Gateway throttling protects these routes from abuse.
 */
export const publicRoutes = new Hono();

async function getTenantBySlug(slug: string): Promise<Tenant> {
  const tenant = await getDb().query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant || !tenant.settings.onlineBookingEnabled) throw notFound('business');
  return tenant;
}

publicRoutes.get('/public/:slug', async (c) => {
  const tenant = await getTenantBySlug(c.req.param('slug'));
  const list = await getDb()
    .select()
    .from(services)
    .where(and(eq(services.tenantId, tenant.id), eq(services.active, true)))
    .orderBy(asc(services.name));
  const body: PublicBusinessDto = {
    name: tenant.name,
    slug: tenant.slug,
    businessType: tenant.businessType,
    timezone: tenant.timezone,
    locale: tenant.locale as Locale,
    phone: tenant.phone,
    hours: tenant.settings.hours,
    services: list.map((s) => ({
      id: s.id,
      name: s.name,
      durationMin: s.durationMin,
      priceCents: s.priceCents,
    })),
    deposit: (() => {
      const d = paymentSettingsOf(tenant.settings).deposit;
      return d.enabled ? { type: d.type, value: d.value } : null;
    })(),
  };
  return c.json(body);
});

/** Free slots for a service on a given local date (YYYY-MM-DD). */
export async function computeSlots(
  tenant: Tenant,
  durationMin: number,
  date: string,
  now: DateTime = DateTime.now(),
): Promise<string[]> {
  const { hours } = tenant.settings;
  const day = DateTime.fromISO(date, { zone: tenant.timezone });
  if (!day.isValid || !hours.days.includes(day.weekday)) return [];

  const [oh, om] = hours.open.split(':').map(Number) as [number, number];
  const [ch, cm] = hours.close.split(':').map(Number) as [number, number];
  const open = day.set({ hour: oh, minute: om, second: 0, millisecond: 0 });
  const close = day.set({ hour: ch, minute: cm, second: 0, millisecond: 0 });

  // Load the day's busy intervals once instead of one query per slot.
  const active = await getDb()
    .select({ s: appointments.startsAt, e: appointments.endsAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.tenantId, tenant.id),
        inArray(appointments.status, ['scheduled', 'confirmed']),
        lt(appointments.startsAt, close.toJSDate()),
        gt(appointments.endsAt, open.toJSDate()),
      ),
    );

  const slots: string[] = [];
  for (let t = open; t.plus({ minutes: durationMin }) <= close; t = t.plus({ minutes: hours.slotMinutes })) {
    if (t <= now) continue;
    const s = t.toJSDate();
    const e = t.plus({ minutes: durationMin }).toJSDate();
    if (!active.some((b) => b.s < e && b.e > s)) slots.push(t.toISO()!);
  }
  return slots;
}

publicRoutes.get('/public/:slug/availability', async (c) => {
  const tenant = await getTenantBySlug(c.req.param('slug'));
  const serviceId = c.req.query('serviceId');
  const date = c.req.query('date');
  if (!serviceId || !date) throw new AppError(400, 'missing_params', 'serviceId and date required');
  const service = await getDb().query.services.findFirst({
    where: and(eq(services.id, serviceId), eq(services.tenantId, tenant.id), eq(services.active, true)),
  });
  if (!service) throw notFound('service');
  return c.json({ slots: await computeSlots(tenant, service.durationMin, date) });
});

publicRoutes.post('/public/:slug/bookings', async (c) => {
  const tenant = await getTenantBySlug(c.req.param('slug'));
  const input = publicBookingSchema.parse(await c.req.json());
  const db = getDb();

  const service = await db.query.services.findFirst({
    where: and(
      eq(services.id, input.serviceId),
      eq(services.tenantId, tenant.id),
      eq(services.active, true),
    ),
  });
  if (!service) throw notFound('service');

  const start = DateTime.fromISO(input.startsAt).setZone(tenant.timezone);
  const date = start.toISODate()!;
  const slots = await computeSlots(tenant, service.durationMin, date);
  if (!slots.some((s) => DateTime.fromISO(s).toMillis() === start.toMillis())) {
    throw conflict('slot_unavailable', 'This time is no longer available');
  }

  const startsAt = start.toJSDate();
  const endsAt = start.plus({ minutes: service.durationMin }).toJSDate();
  const phone = normalizeMxPhone(input.phone);

  const result = await db.transaction(async (tx) => {
    // Lock the tenant row so two simultaneous bookings can't take the same slot.
    await tx.execute(sql`select id from tenants where id = ${tenant.id} for update`);
    if (await hasOverlap(tx, tenant.id, startsAt, endsAt)) {
      throw conflict('slot_unavailable', 'This time is no longer available');
    }
    let customer = await tx.query.customers.findFirst({
      where: and(eq(customers.tenantId, tenant.id), eq(customers.phone, phone)),
    });
    if (!customer) {
      [customer] = await tx
        .insert(customers)
        .values({ tenantId: tenant.id, name: input.name, phone, email: input.email || null })
        .returning();
    }
    const [appt] = await tx
      .insert(appointments)
      .values({
        tenantId: tenant.id,
        customerId: customer!.id,
        serviceId: service.id,
        startsAt,
        endsAt,
        priceCents: service.priceCents,
        source: 'online',
        notes: input.notes ?? null,
      })
      .returning();
    return { appt: appt!, customer: customer! };
  });

  const body: PublicBookingResult = {
    id: result.appt.id,
    startsAt: result.appt.startsAt.toISOString(),
    endsAt: result.appt.endsAt.toISOString(),
    serviceName: service.name,
    businessName: tenant.name,
    deposit: null,
  };

  // Optional deposit: pay online with the business's Mercado Pago, or by bank transfer.
  const pay = paymentSettingsOf(tenant.settings);
  const amountCents = computeDepositCents(service.priceCents, pay);
  if (amountCents > 0) {
    body.deposit = { amountCents, checkoutUrl: null, method: null, transfer: null };
    const online = pay.methods.mercadopago ? 'mercadopago' : pay.methods.spei ? 'spei' : null;
    if (online && tenantMpToken(tenant) && amountCents >= 100) {
      try {
        const payment = await createOnlinePayment(db, tenant, {
          appointmentId: result.appt.id,
          customerId: result.customer.id,
          customerEmail: result.customer.email,
          title: `Anticipo: ${service.name}`,
          amountCents,
          method: online,
          apiBase: apiBaseUrl(c.req.url),
        });
        body.deposit.checkoutUrl = payment.checkoutUrl;
        body.deposit.method = online;
      } catch (err) {
        // The booking stands; the business can request the deposit later.
        console.error('deposit checkout failed', err);
      }
    }
    if (!body.deposit.checkoutUrl && pay.methods.transfer && pay.transfer.clabe) {
      body.deposit.method = 'transfer';
      body.deposit.transfer = { ...pay.transfer };
    }
  }

  return c.json(body, 201);
});
