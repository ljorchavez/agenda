import { Hono } from 'hono';
import { and, asc, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import {
  couponsEnabled,
  pageSettingsOf,
  rewardSettingsOf,
  bookingPriceCents,
  businessKind,
  computeDepositCents,
  eligibleResources,
  kindConfig,
  normalizeMxPhone,
  paymentSettingsOf,
  publicBookingSchema,
  publicClassBookingSchema,
  rentalSettingsOf,
  reservationSettingsOf,
  intervalsOnWeekday,
  type Locale,
  type PublicBookingResult,
  type PublicBusinessDto,
} from '@agenda/shared';
import { getDb, type Db } from '../db/client.js';
import { appointments, customers, services, tenants, type Appointment, type Customer, type Service, type Tenant } from '../db/schema.js';
import { hasOverlap } from '../lib/appointments.js';
import { findUsableCoupon, resolveDiscount } from '../lib/discounts.js';
import { customerPlans as customerPlansOf } from '../lib/plans.js';
import { publicReviewSummary } from './reviews.js';
import { shopFor } from '../lib/online-sales.js';
import { assertRoom, lockSession, querySessions, toPublicSession } from '../lib/classes.js';
import { assertCanAddBooking, assertCanAddCustomer } from '../lib/plan.js';
import { activeResources, assignResource, closedRanges, defaultService, locationBlocks, pickResource, resourceBusy, type Need } from '../lib/resources.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { hoursFor, listLocations, resolveLocation, toPublicLocation } from '../lib/locations.js';
import { manageToken } from '../lib/crypto.js';
import { notifyAppointment } from '../lib/notify.js';
import { apiBaseUrl, createOnlinePayment, tenantMpToken } from '../lib/online-payments.js';

/**
 * Unauthenticated endpoints for the public booking page (/b/:slug).
 * Only exposes the business's public info, services and resources (first names, courts, tables) — never customer data.
 * Every kind of business books through the same code; KIND_CONFIG says which fields apply.
 */
export const publicRoutes = new Hono();

export async function getTenantBySlug(slug: string): Promise<Tenant> {
  const tenant = await getDb().query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant || !tenant.settings.onlineBookingEnabled) throw notFound('business');
  return tenant;
}

publicRoutes.get('/public/:slug', async (c) => {
  const tenant = await getTenantBySlug(c.req.param('slug'));
  const db = getDb();
  const kind = businessKind(tenant.businessType);
  const cfg = kindConfig(kind);
  const [list, res, locs] = await Promise.all([
    db
      .select()
      .from(services)
      .where(and(eq(services.tenantId, tenant.id), eq(services.active, true)))
      .orderBy(asc(services.name)),
    activeResources(db, tenant.id),
    listLocations(db, tenant.id),
  ]);
  const activeLocs = locs.filter((l) => l.active);
  const activeIds = new Set(activeLocs.map((l) => l.id));
  const body: PublicBusinessDto = {
    name: tenant.name,
    slug: tenant.slug,
    businessType: tenant.businessType,
    timezone: tenant.timezone,
    locale: tenant.locale as Locale,
    phone: tenant.phone,
    hours: tenant.settings.hours,
    services: cfg.durations ? [] : list.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, priceCents: s.priceCents, photoUrl: s.photoUrl ?? null })),
    deposit: (() => {
      const d = paymentSettingsOf(tenant.settings).deposit;
      return d.enabled ? { type: d.type, value: d.value } : null;
    })(),
    kind,
    description: tenant.description,
    address: tenant.address,
    neighborhood: tenant.neighborhood,
    city: tenant.city,
    state: tenant.state,
    lat: tenant.lat,
    lng: tenant.lng,
    maxPartySize: cfg.partySize ? reservationSettingsOf(tenant.settings).maxPartySize : null,
    resources: res
      .filter((r) => activeIds.has(r.locationId))
      .map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        serviceIds: r.serviceIds ?? [],
        capacity: r.capacity,
        pricePerHourCents: r.pricePerHourCents,
        description: r.description,
        locationId: r.locationId,
        photoUrl: r.photoUrl ?? null,
      })),
    rentalDurations: cfg.durations ? rentalSettingsOf(tenant.settings).durations : null,
    locations: activeLocs.map((l) => toPublicLocation(tenant, l)),
    page: pageSettingsOf(tenant.settings),
    reviews: await publicReviewSummary(getDb(), tenant, 5),
    shop: await shopFor(getDb(), tenant),
    promos: (() => {
      const r = rewardSettingsOf(tenant.settings);
      return { coupons: couponsEnabled(tenant.settings), reward: r.enabled ? { everyVisits: r.everyVisits, discountType: r.discountType, value: r.value } : null };
    })(),
  };
  return c.json(body);
});

/** Checks a coupon code on the booking page: what it takes off, or why it can't be used. */
publicRoutes.get('/public/:slug/coupons/:code', async (c) => {
  const tenant = await getTenantBySlug(c.req.param('slug'));
  // Optional context: the chosen service and the phone typed so far (the booking checks again).
  const db = getDb();
  const serviceId = c.req.query('serviceId');
  const phone = c.req.query('phone');
  const known = phone && phone.replace(/\D/g, '').length >= 10
    ? await db.query.customers.findFirst({ where: and(eq(customers.tenantId, tenant.id), eq(customers.phone, normalizeMxPhone(phone))) })
    : null;
  const coupon = await findUsableCoupon(db, tenant.id, tenant.settings, c.req.param('code'), DateTime.now().setZone(tenant.timezone).toISODate()!, {
    serviceId: serviceId && /^[0-9a-f-]{36}$/.test(serviceId) ? serviceId : null,
    customerId: known?.id ?? null,
  });
  return c.json({ code: coupon.code, discountType: coupon.discountType, value: coupon.value });
});

/**
 * Free start times on a local date (YYYY-MM-DD) for a booking of `durationMin`.
 * With resources, a time is free when some resource that takes the service and fits the party
 * (or the requested one) is working, not blocked and free. A resource with its own hours follows
 * them (Mario 8–17, Ramiro 10–20); the rest follow the location's hours, breaks included.
 * Without resources the location works as a single agenda.
 */
export async function computeSlots(
  tenant: Tenant,
  durationMin: number,
  date: string,
  now: DateTime = DateTime.now(),
  opts: Need & { excludeId?: string; resourceId?: string | null; locationId?: string } = {},
): Promise<string[]> {
  const db = getDb();
  const loc = await resolveLocation(db, tenant.id, opts.locationId);
  const hours = hoursFor(tenant, loc);
  const day = DateTime.fromISO(date, { zone: tenant.timezone });
  if (!day.isValid) return [];
  const dayStart = day.startOf('day');
  const dayEnd = dayStart.plus({ days: 1 });
  const step = hours.slotMinutes;

  /** Start times inside each open stretch, every `step` minutes from its opening. */
  const startsIn = (stretches: [number, number][]) => {
    const out = new Set<number>();
    for (const [o, c] of stretches) for (let m = o; m + durationMin <= c; m += step) out.add(m);
    return out;
  };
  const toTimes = (mins: Set<number>) =>
    [...mins].sort((a, b) => a - b).map((m) => dayStart.plus({ minutes: m })).filter((t) => t > now);

  const list = await activeResources(db, tenant.id, loc.id);
  if (list.length) {
    let eligible = eligibleResources(list, opts);
    if (opts.resourceId) eligible = eligible.filter((r) => r.id === opts.resourceId);
    if (!eligible.length) return [];
    const mins = new Set<number>();
    for (const r of eligible) for (const m of startsIn(intervalsOnWeekday(r.hours ?? hours, day.weekday))) mins.add(m);
    const from = dayStart.toJSDate();
    const to = dayEnd.toJSDate();
    const busy = await resourceBusy(db, tenant.id, from, to, { excludeId: opts.excludeId, locationId: loc.id });
    // Hours off: own schedule, or the location's when it has none (closed days, breaks).
    busy.push(...eligible.flatMap((r) => closedRanges(r.hours ?? hours, from, to, tenant.timezone).map((x) => ({ ...x, rid: r.id, soft: true }))));
    return toTimes(mins)
      .filter((t) => pickResource(eligible, busy, t.toJSDate(), t.plus({ minutes: durationMin }).toJSDate()))
      .map((t) => t.toISO()!);
  }

  // Single agenda: load the day's bookings and blocked times once instead of one query per slot.
  const [active, blocked] = await Promise.all([
    db
      .select({ s: appointments.startsAt, e: appointments.endsAt })
      .from(appointments)
      .where(
        and(
          eq(appointments.tenantId, tenant.id),
          eq(appointments.locationId, loc.id),
          inArray(appointments.status, ['scheduled', 'confirmed']),
          lt(appointments.startsAt, dayEnd.toJSDate()),
          gt(appointments.endsAt, dayStart.toJSDate()),
          sql`${appointments.classSessionId} is null and ${appointments.resourceId} is null`,
          opts.excludeId ? ne(appointments.id, opts.excludeId) : undefined,
        ),
      ),
    locationBlocks(db, tenant.id, dayStart.toJSDate(), dayEnd.toJSDate(), loc.id),
  ]);
  const taken = [...active, ...blocked];
  return toTimes(startsIn(intervalsOnWeekday(hours, day.weekday)))
    .filter((t) => {
      const s = t.toJSDate();
      const e = t.plus({ minutes: durationMin }).toJSDate();
      return !taken.some((b) => b.s < e && b.e > s);
    })
    .map((t) => t.toISO()!);
}

/**
 * What a booking request means for this kind of business: the service, its length and the party.
 * Throws 400/422 when a field the kind needs is missing or not allowed.
 */
export async function bookingSpec(
  db: Db,
  tenant: Tenant,
  input: { serviceId?: string | null; partySize?: number | null; durationMin?: number | null },
): Promise<{ service: Service; durationMin: number; partySize: number | null }> {
  const kind = businessKind(tenant.businessType);
  const cfg = kindConfig(kind);
  if (cfg.partySize) {
    const rs = reservationSettingsOf(tenant.settings);
    if (!input.partySize) throw new AppError(400, 'missing_params', 'partySize required');
    if (input.partySize > rs.maxPartySize) throw new AppError(422, 'party_too_large', `Max ${rs.maxPartySize} people online`);
    return { service: await defaultService(db, tenant, kind), durationMin: rs.durationMin, partySize: input.partySize };
  }
  if (cfg.durations) {
    if (!input.durationMin || !rentalSettingsOf(tenant.settings).durations.includes(input.durationMin)) {
      throw new AppError(422, 'invalid_duration', 'durationMin must be one of the allowed durations');
    }
    return { service: await defaultService(db, tenant, kind), durationMin: input.durationMin, partySize: input.partySize ?? null };
  }
  if (!input.serviceId) throw new AppError(400, 'missing_params', 'serviceId required');
  const service = await db.query.services.findFirst({
    where: and(eq(services.id, input.serviceId), eq(services.tenantId, tenant.id), eq(services.active, true)),
  });
  if (!service) throw notFound('service');
  return { service, durationMin: service.durationMin, partySize: input.partySize ?? null };
}

/** Class starts on a local date that still have `spots` free (optionally one class type). */
export async function computeClassSlots(
  tenant: Tenant,
  date: string,
  now: DateTime = DateTime.now(),
  opts: { serviceId?: string; spots?: number; excludeSessionId?: string; locationId?: string } = {},
): Promise<{ sessionId: string; startsAt: string }[]> {
  const day = DateTime.fromISO(date, { zone: tenant.timezone });
  if (!day.isValid) return [];
  const from = DateTime.max(day.startOf('day'), now);
  const list = await querySessions(
    getDb(),
    tenant.id,
    sql`cs.status = 'scheduled' and cs.starts_at > ${from.toUTC().toISO()} and cs.starts_at < ${day.endOf('day').toUTC().toISO()}
        ${opts.serviceId ? sql`and cs.service_id = ${opts.serviceId}` : sql``}
        ${opts.excludeSessionId ? sql`and cs.id <> ${opts.excludeSessionId}` : sql``}
        ${opts.locationId ? sql`and cs.location_id = ${opts.locationId}` : sql``}`,
  );
  return list
    .filter((s) => s.capacity - s.booked >= (opts.spots ?? 1))
    .map((s) => ({ sessionId: s.id, startsAt: DateTime.fromISO(s.startsAt).setZone(tenant.timezone).toISO()! }));
}

const sameInstant = (slots: string[], start: DateTime) => slots.some((s) => DateTime.fromISO(s).toMillis() === start.toMillis());
const num = (v: string | undefined) => (v ? Number(v) : null);

publicRoutes.get('/public/:slug/availability', async (c) => {
  const tenant = await getTenantBySlug(c.req.param('slug'));
  const date = c.req.query('date');
  if (!date) throw new AppError(400, 'missing_params', 'date required');
  const db = getDb();
  const resourceId = c.req.query('resourceId') || null;
  // A chosen resource decides the location when none is given.
  let locationId = c.req.query('locationId') || undefined;
  if (!locationId && resourceId) locationId = (await activeResources(db, tenant.id)).find((r) => r.id === resourceId)?.locationId;

  if (kindConfig(businessKind(tenant.businessType)).sessions) {
    const list = await computeClassSlots(tenant, date, DateTime.now(), { serviceId: c.req.query('serviceId') || undefined, locationId });
    return c.json({ slots: list.map((s) => s.startsAt) });
  }
  let spec;
  try {
    spec = await bookingSpec(db, tenant, {
      serviceId: c.req.query('serviceId'),
      partySize: num(c.req.query('partySize')),
      durationMin: num(c.req.query('durationMin')),
    });
  } catch (err) {
    // Too many people for online booking: just no times.
    if (err instanceof AppError && err.code === 'party_too_large') return c.json({ slots: [] });
    throw err;
  }
  return c.json({
    slots: await computeSlots(tenant, spec.durationMin, date, DateTime.now(), {
      serviceId: spec.service.id,
      partySize: spec.partySize,
      resourceId,
      locationId,
    }),
  });
});

/** Upcoming classes with spots left: ?from=YYYY-MM-DD&days=14 (max 31). */
publicRoutes.get('/public/:slug/classes', async (c) => {
  const tenant = await getTenantBySlug(c.req.param('slug'));
  if (businessKind(tenant.businessType) !== 'classes') return c.json([]);
  const days = Math.min(31, Math.max(1, Number(c.req.query('days') ?? 14) || 14));
  const fromQ = c.req.query('from');
  const start = fromQ ? DateTime.fromISO(fromQ, { zone: tenant.timezone }) : DateTime.now().setZone(tenant.timezone);
  if (!start.isValid) throw new AppError(400, 'invalid_date');
  const from = DateTime.max(start.startOf('day'), DateTime.now());
  const to = start.startOf('day').plus({ days });
  const list = await querySessions(
    getDb(),
    tenant.id,
    sql`cs.status = 'scheduled' and cs.starts_at > ${from.toUTC().toISO()} and cs.starts_at < ${to.toUTC().toISO()}
        ${c.req.query('locationId') ? sql`and cs.location_id = ${c.req.query('locationId')!}` : sql``}
        and exists (select 1 from locations l where l.id = cs.location_id and l.active)`,
    500,
  );
  return c.json(list.map(toPublicSession));
});

export async function findOrCreateCustomer(
  tx: Pick<Db, 'query' | 'insert' | 'update' | 'execute'>,
  tenantId: string,
  input: { name: string; phone: string; email?: string },
) {
  const phone = normalizeMxPhone(input.phone);
  const existing = await tx.query.customers.findFirst({
    where: and(eq(customers.tenantId, tenantId), eq(customers.phone, phone)),
  });
  if (existing) {
    // Keep the email they just gave so confirmations and reminders reach them.
    if (input.email && !existing.email) {
      const [updated] = await tx.update(customers).set({ email: input.email }).where(eq(customers.id, existing.id)).returning();
      return updated ?? existing;
    }
    return existing;
  }
  await assertCanAddCustomer(tx, tenantId);
  const [created] = await tx
    .insert(customers)
    .values({ tenantId, name: input.name, phone, email: input.email || null })
    .returning();
  return created!;
}

const lockTenant = (tx: Pick<Db, 'execute'>, tenantId: string) => tx.execute(sql`select id from tenants where id = ${tenantId} for update`);

function result(tenant: Tenant, appt: Appointment, serviceName: string, resourceName: string | null): PublicBookingResult {
  return {
    id: appt.id,
    startsAt: appt.startsAt.toISOString(),
    endsAt: appt.endsAt.toISOString(),
    serviceName,
    businessName: tenant.name,
    partySize: appt.partySize,
    resourceName,
    priceCents: appt.priceCents,
    discountCents: appt.discountCents,
    discountReason: appt.discountReason ?? null,
    plans: [],
    managePath: `/c/${manageToken(appt.id)}`,
    deposit: null,
  };
}

/** The customer's active packages/memberships, as shown to them ("te quedan 3 clases"). */
export async function publicPlans(tenant: Tenant, customerId: string): Promise<PublicBookingResult['plans']> {
  const today = DateTime.now().setZone(tenant.timezone).toISODate()!;
  return (await customerPlansOf(getDb(), tenant.id, customerId, today))
    .filter((p) => p.status === 'active')
    .map((p) => ({ name: p.name, sessionsLeft: p.sessionsLeft, expiresOn: p.expiresOn }));
}

/** Optional deposit: pay online with the business's Mercado Pago, or by bank transfer. */
async function attachDeposit(
  requestUrl: string,
  tenant: Tenant,
  body: PublicBookingResult,
  appt: Appointment,
  customer: Customer,
  title: string,
): Promise<PublicBookingResult> {
  const pay = paymentSettingsOf(tenant.settings);
  const amountCents = computeDepositCents(appt.priceCents, pay);
  if (amountCents <= 0) return body;
  body.deposit = { amountCents, checkoutUrl: null, method: null, transfer: null };
  const online = pay.methods.mercadopago ? 'mercadopago' : pay.methods.spei ? 'spei' : null;
  if (online && tenantMpToken(tenant) && amountCents >= 100) {
    try {
      const payment = await createOnlinePayment(getDb(), tenant, {
        appointmentId: appt.id,
        customerId: customer.id,
        customerEmail: customer.email,
        title: `Anticipo: ${title}`,
        amountCents,
        method: online,
        apiBase: apiBaseUrl(requestUrl),
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
  return body;
}

/** Group class: takes `spots` places in a session if they still fit. */
async function bookClass(requestUrl: string, tenant: Tenant, raw: unknown): Promise<PublicBookingResult> {
  const input = publicClassBookingSchema.parse(raw);
  const db = getDb();
  const { appt, customer, serviceName, res } = await db.transaction(async (tx) => {
    const { session, booked } = await lockSession(tx, tenant.id, input.classSessionId);
    if (session.status !== 'scheduled' || session.startsAt <= new Date()) {
      throw conflict('slot_unavailable', 'This class is no longer available');
    }
    assertRoom(session.capacity, booked, input.spots);
    const service = await tx.query.services.findFirst({ where: and(eq(services.id, session.serviceId), eq(services.tenantId, tenant.id)) });
    if (!service) throw notFound('service');
    await assertCanAddBooking(tx, tenant.id);
    const customer = await findOrCreateCustomer(tx, tenant.id, input);
    const dup = await tx.execute(sql`
      select 1 from appointments where class_session_id = ${session.id} and customer_id = ${customer.id}
        and status in ('scheduled', 'confirmed') limit 1`);
    if (dup.rows.length) throw conflict('already_booked', 'You already have a spot in this class');
    const [row] = await tx
      .insert(appointments)
      .values({
        tenantId: tenant.id,
        customerId: customer.id,
        serviceId: service.id,
        classSessionId: session.id,
        resourceId: session.resourceId,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        partySize: input.spots,
        ...(await (async () => {
          const full = service.priceCents * input.spots;
          const d = await resolveDiscount(tx, tenant, { customerId: customer.id, serviceId: service.id, couponCode: input.couponCode, priceCents: full, today: DateTime.now().setZone(tenant.timezone).toISODate()! });
          return { priceCents: full - d.discountCents, discountCents: d.discountCents, discountReason: d.reason, couponId: d.couponId };
        })()),
        locationId: session.locationId,
        source: 'online',
        notes: input.notes ?? null,
      })
      .returning();
    const res = session.resourceId ? await tx.query.resources.findFirst({ where: (r, { eq: e }) => e(r.id, session.resourceId!) }) : null;
    return { appt: row!, customer, serviceName: service.name, res };
  });
  return attachDeposit(requestUrl, tenant, { ...result(tenant, appt, serviceName, res?.name ?? null), plans: await publicPlans(tenant, customer.id) }, appt, customer, serviceName);
}

/** Any booking that isn't a class: a service, a table for a party or a space for a while. */
async function bookResource(requestUrl: string, tenant: Tenant, raw: unknown): Promise<PublicBookingResult> {
  const input = publicBookingSchema.parse(raw);
  const db = getDb();
  const { service, durationMin, partySize } = await bookingSpec(db, tenant, input);
  // A chosen resource decides the location.
  const chosen = input.resourceId ? (await activeResources(db, tenant.id)).find((r) => r.id === input.resourceId) : null;
  if (input.resourceId && !chosen) throw notFound('resource');
  const loc = await resolveLocation(db, tenant.id, chosen?.locationId ?? input.locationId);

  const start = DateTime.fromISO(input.startsAt).setZone(tenant.timezone);
  const slots = await computeSlots(tenant, durationMin, start.toISODate()!, DateTime.now(), {
    serviceId: service.id,
    partySize,
    resourceId: input.resourceId,
    locationId: loc.id,
  });
  if (!sameInstant(slots, start)) throw conflict('slot_unavailable', 'This time is no longer available');
  const startsAt = start.toJSDate();
  const endsAt = start.plus({ minutes: durationMin }).toJSDate();

  const { appt, customer, resource } = await db.transaction(async (tx) => {
    // Lock the tenant row so two simultaneous bookings can't take the same slot.
    await lockTenant(tx, tenant.id);
    let resource = null;
    if ((await activeResources(tx, tenant.id, loc.id)).length) {
      try {
        resource = await assignResource(tx, tenant.id, startsAt, endsAt, { resourceId: input.resourceId, serviceId: service.id, partySize, locationId: loc.id });
      } catch {
        throw conflict('slot_unavailable', 'This time is no longer available');
      }
    } else if (
      (await hasOverlap(tx, tenant.id, startsAt, endsAt, { locationId: loc.id })) ||
      (await locationBlocks(tx, tenant.id, startsAt, endsAt, loc.id)).length
    ) {
      throw conflict('slot_unavailable', 'This time is no longer available');
    }
    await assertCanAddBooking(tx, tenant.id);
    const customer = await findOrCreateCustomer(tx, tenant.id, input);
    const fullPrice = bookingPriceCents(resource, service.priceCents, durationMin);
    const discount = await resolveDiscount(tx, tenant, {
      customerId: customer.id,
      serviceId: service.id,
      couponCode: input.couponCode,
      priceCents: fullPrice,
      today: DateTime.now().setZone(tenant.timezone).toISODate()!,
    });
    const [row] = await tx
      .insert(appointments)
      .values({
        tenantId: tenant.id,
        customerId: customer.id,
        serviceId: service.id,
        resourceId: resource?.id ?? null,
        locationId: loc.id,
        startsAt,
        endsAt,
        partySize,
        priceCents: fullPrice - discount.discountCents,
        discountCents: discount.discountCents,
        discountReason: discount.reason,
        couponId: discount.couponId,
        source: 'online',
        notes: input.notes ?? null,
      })
      .returning();
    return { appt: row!, customer, resource };
  });
  const title = kindConfig(businessKind(tenant.businessType)).durations && resource ? `${resource.name} (${durationMin} min)` : service.name;
  return attachDeposit(requestUrl, tenant, { ...result(tenant, appt, service.name, resource?.name ?? null), plans: await publicPlans(tenant, customer.id) }, appt, customer, title);
}

publicRoutes.post('/public/:slug/bookings', async (c) => {
  const tenant = await getTenantBySlug(c.req.param('slug'));
  const body = await c.req.json();
  const booked = kindConfig(businessKind(tenant.businessType)).sessions ? await bookClass(c.req.url, tenant, body) : await bookResource(c.req.url, tenant, body);
  await notifyAppointment(booked.id, 'booked');
  return c.json(booked, 201);
});
