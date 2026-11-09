import { Hono } from 'hono';
import { and, asc, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import {
  businessKind,
  computeDepositCents,
  normalizeMxPhone,
  paymentSettingsOf,
  publicBookingSchema,
  publicClassBookingSchema,
  publicRentalSchema,
  publicReservationSchema,
  rentalSettingsOf,
  reservationSettingsOf,
  spacePriceCents,
  type BusinessHours,
  type Locale,
  type PublicBookingResult,
  type PublicBusinessDto,
} from '@agenda/shared';
import { getDb, type Db } from '../db/client.js';
import { appointments, customers, services, tenants, type Appointment, type Customer, type Tenant } from '../db/schema.js';
import { hasOverlap } from '../lib/appointments.js';
import { assertRoom, lockSession, querySessions, toPublicSession } from '../lib/classes.js';
import { assignTable, loadTableState, pickTable, reservationService } from '../lib/tables.js';
import {
  activeProfessionals,
  activeSpaces,
  assignProfessional,
  assignSpace,
  eligibleFor,
  internalService,
  pickProfessional,
  pickSpace,
  professionalBusy,
  RENTAL_SERVICE_NAME,
  spaceBusy,
} from '../lib/resources.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { hoursFor, listLocations, resolveLocation, toPublicLocation } from '../lib/locations.js';
import { manageToken } from '../lib/crypto.js';
import { apiBaseUrl, createOnlinePayment, tenantMpToken } from '../lib/online-payments.js';

/**
 * Unauthenticated endpoints for the public booking page (/b/:slug).
 * Only exposes the business's public info, services, team first names and spaces — never customer data.
 * In AWS, API Gateway throttling protects these routes from abuse.
 */
export const publicRoutes = new Hono();

async function getTenantBySlug(slug: string): Promise<Tenant> {
  const tenant = await getDb().query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (!tenant || !tenant.settings.onlineBookingEnabled) throw notFound('business');
  return tenant;
}

/** Opening and closing instants for a local date, or null when closed. */
function dayWindow(tenant: Tenant, date: string, hours: BusinessHours = tenant.settings.hours) {
  const day = DateTime.fromISO(date, { zone: tenant.timezone });
  if (!day.isValid || !hours.days.includes(day.weekday)) return null;
  const [oh, om] = hours.open.split(':').map(Number) as [number, number];
  const [ch, cm] = hours.close.split(':').map(Number) as [number, number];
  return {
    open: day.set({ hour: oh, minute: om, second: 0, millisecond: 0 }),
    close: day.set({ hour: ch, minute: cm, second: 0, millisecond: 0 }),
    step: hours.slotMinutes,
  };
}

publicRoutes.get('/public/:slug', async (c) => {
  const tenant = await getTenantBySlug(c.req.param('slug'));
  const db = getDb();
  const kind = businessKind(tenant.businessType);
  const [list, pros, spaceList, locs] = await Promise.all([
    db
      .select()
      .from(services)
      .where(and(eq(services.tenantId, tenant.id), eq(services.active, true)))
      .orderBy(asc(services.name)),
    kind === 'appointments' ? activeProfessionals(db, tenant.id) : Promise.resolve([]),
    kind === 'rentals' ? activeSpaces(db, tenant.id) : Promise.resolve([]),
    listLocations(db, tenant.id),
  ]);
  const activeLocs = locs.filter((l) => l.active);
  const activeIds = new Set(activeLocs.map((l) => l.id));
  spaceList.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
  const body: PublicBusinessDto = {
    name: tenant.name,
    slug: tenant.slug,
    businessType: tenant.businessType,
    timezone: tenant.timezone,
    locale: tenant.locale as Locale,
    phone: tenant.phone,
    hours: tenant.settings.hours,
    services: kind === 'rentals' ? [] : list.map((s) => ({ id: s.id, name: s.name, durationMin: s.durationMin, priceCents: s.priceCents })),
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
    maxPartySize: kind === 'reservations' ? reservationSettingsOf(tenant.settings).maxPartySize : null,
    professionals: pros
      .filter((p) => activeIds.has(p.locationId))
      .map((p) => ({ id: p.id, name: p.name, color: p.color, serviceIds: p.serviceIds ?? [], locationId: p.locationId })),
    spaces: spaceList
      .filter((x) => activeIds.has(x.locationId))
      .map((x) => ({ id: x.id, name: x.name, description: x.description, pricePerHourCents: x.pricePerHourCents, locationId: x.locationId })),
    rentalDurations: kind === 'rentals' ? rentalSettingsOf(tenant.settings).durations : null,
    locations: activeLocs.map((l) => toPublicLocation(tenant, l)),
  };
  return c.json(body);
});

/**
 * Free slots for a service on a local date (YYYY-MM-DD).
 * With a team, a slot is free when some professional who does the service (or the requested one) is free.
 */
export async function computeSlots(
  tenant: Tenant,
  durationMin: number,
  date: string,
  now: DateTime = DateTime.now(),
  opts: { excludeId?: string; serviceId?: string; professionalId?: string | null; locationId?: string } = {},
): Promise<string[]> {
  const db = getDb();
  const loc = await resolveLocation(db, tenant.id, opts.locationId);
  const w = dayWindow(tenant, date, hoursFor(tenant, loc));
  if (!w) return [];
  const pros = await activeProfessionals(db, tenant.id, loc.id);

  if (pros.length) {
    let eligible = eligibleFor(pros, opts.serviceId);
    if (opts.professionalId) eligible = eligible.filter((p) => p.id === opts.professionalId);
    if (!eligible.length) return [];
    const busy = await professionalBusy(db, tenant.id, w.open.toJSDate(), w.close.toJSDate(), opts.excludeId, loc.id);
    const slots: string[] = [];
    for (let t = w.open; t.plus({ minutes: durationMin }) <= w.close; t = t.plus({ minutes: w.step })) {
      if (t <= now) continue;
      if (pickProfessional(eligible, busy, t.toJSDate(), t.plus({ minutes: durationMin }).toJSDate())) slots.push(t.toISO()!);
    }
    return slots;
  }

  // Single agenda: load the day's busy intervals once instead of one query per slot.
  const active = await db
    .select({ s: appointments.startsAt, e: appointments.endsAt })
    .from(appointments)
    .where(
      and(
        eq(appointments.tenantId, tenant.id),
        eq(appointments.locationId, loc.id),
        inArray(appointments.status, ['scheduled', 'confirmed']),
        lt(appointments.startsAt, w.close.toJSDate()),
        gt(appointments.endsAt, w.open.toJSDate()),
        sql`${appointments.classSessionId} is null and ${appointments.spaceId} is null and ${appointments.tableId} is null`,
        opts.excludeId ? ne(appointments.id, opts.excludeId) : undefined,
      ),
    );
  const slots: string[] = [];
  for (let t = w.open; t.plus({ minutes: durationMin }) <= w.close; t = t.plus({ minutes: w.step })) {
    if (t <= now) continue;
    const s = t.toJSDate();
    const e = t.plus({ minutes: durationMin }).toJSDate();
    if (!active.some((b) => b.s < e && b.e > s)) slots.push(t.toISO()!);
  }
  return slots;
}

/** Restaurant slots: times where some free table fits the party. */
export async function computeTableSlots(
  tenant: Tenant,
  partySize: number,
  date: string,
  now: DateTime = DateTime.now(),
  opts: { excludeId?: string; durationMin?: number; locationId?: string } = {},
): Promise<string[]> {
  const db = getDb();
  const loc = await resolveLocation(db, tenant.id, opts.locationId);
  const w = dayWindow(tenant, date, hoursFor(tenant, loc));
  if (!w) return [];
  const durationMin = opts.durationMin ?? reservationSettingsOf(tenant.settings).durationMin;
  const { tables, busy } = await loadTableState(db, tenant.id, partySize, w.open.toJSDate(), w.close.toJSDate(), opts.excludeId, loc.id);
  if (!tables.length) return [];
  const slots: string[] = [];
  for (let t = w.open; t.plus({ minutes: durationMin }) <= w.close; t = t.plus({ minutes: w.step })) {
    if (t <= now) continue;
    if (pickTable(tables, busy, partySize, t.toJSDate(), t.plus({ minutes: durationMin }).toJSDate())) slots.push(t.toISO()!);
  }
  return slots;
}

/** Rental slots: start times where the requested space (or any space) is free for the duration. */
export async function computeSpaceSlots(
  tenant: Tenant,
  durationMin: number,
  date: string,
  now: DateTime = DateTime.now(),
  opts: { excludeId?: string; spaceId?: string | null; locationId?: string } = {},
): Promise<string[]> {
  const db = getDb();
  const loc = await resolveLocation(db, tenant.id, opts.locationId);
  const w = dayWindow(tenant, date, hoursFor(tenant, loc));
  if (!w) return [];
  const list = await activeSpaces(db, tenant.id, loc.id);
  if (!list.length || (opts.spaceId && !list.some((s) => s.id === opts.spaceId))) return [];
  const busy = await spaceBusy(db, tenant.id, w.open.toJSDate(), w.close.toJSDate(), opts.excludeId);
  const slots: string[] = [];
  for (let t = w.open; t.plus({ minutes: durationMin }) <= w.close; t = t.plus({ minutes: w.step })) {
    if (t <= now) continue;
    if (pickSpace(list, busy, t.toJSDate(), t.plus({ minutes: durationMin }).toJSDate(), opts.spaceId)) slots.push(t.toISO()!);
  }
  return slots;
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

publicRoutes.get('/public/:slug/availability', async (c) => {
  const tenant = await getTenantBySlug(c.req.param('slug'));
  const date = c.req.query('date');
  const kind = businessKind(tenant.businessType);
  if (!date) throw new AppError(400, 'missing_params', 'date required');
  // A chosen professional or space decides the location when none is given.
  let locationId = c.req.query('locationId') || undefined;
  const proQ = c.req.query('professionalId');
  const spaceQ = c.req.query('spaceId');
  if (!locationId && (proQ || spaceQ)) {
    const db = getDb();
    const row = proQ
      ? (await activeProfessionals(db, tenant.id)).find((p) => p.id === proQ)
      : (await activeSpaces(db, tenant.id)).find((x) => x.id === spaceQ);
    locationId = row?.locationId;
  }

  if (kind === 'reservations') {
    const partySize = Number(c.req.query('partySize'));
    const max = reservationSettingsOf(tenant.settings).maxPartySize;
    if (!Number.isInteger(partySize) || partySize < 1) throw new AppError(400, 'missing_params', 'partySize and date required');
    if (partySize > max) return c.json({ slots: [] });
    return c.json({ slots: await computeTableSlots(tenant, partySize, date, DateTime.now(), { locationId }) });
  }
  if (kind === 'rentals') {
    const durationMin = Number(c.req.query('durationMin'));
    if (!rentalSettingsOf(tenant.settings).durations.includes(durationMin)) {
      throw new AppError(400, 'invalid_duration', 'durationMin must be one of the allowed durations');
    }
    return c.json({ slots: await computeSpaceSlots(tenant, durationMin, date, DateTime.now(), { spaceId: c.req.query('spaceId') || null, locationId }) });
  }
  if (kind === 'classes') {
    const list = await computeClassSlots(tenant, date, DateTime.now(), { serviceId: c.req.query('serviceId') || undefined, locationId });
    return c.json({ slots: list.map((s) => s.startsAt) });
  }

  const serviceId = c.req.query('serviceId');
  if (!serviceId) throw new AppError(400, 'missing_params', 'serviceId and date required');
  const service = await getDb().query.services.findFirst({
    where: and(eq(services.id, serviceId), eq(services.tenantId, tenant.id), eq(services.active, true)),
  });
  if (!service) throw notFound('service');
  return c.json({
    slots: await computeSlots(tenant, service.durationMin, date, DateTime.now(), {
      serviceId,
      professionalId: c.req.query('professionalId') || null,
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

async function findOrCreateCustomer(
  tx: Pick<Db, 'query' | 'insert'>,
  tenantId: string,
  input: { name: string; phone: string; email?: string },
) {
  const phone = normalizeMxPhone(input.phone);
  const existing = await tx.query.customers.findFirst({
    where: and(eq(customers.tenantId, tenantId), eq(customers.phone, phone)),
  });
  if (existing) return existing;
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
    managePath: `/c/${manageToken(appt.id)}`,
    deposit: null,
  };
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

/** Restaurant reservation: party size + time, table assigned automatically. */
async function bookTable(tenant: Tenant, raw: unknown): Promise<PublicBookingResult> {
  const input = publicReservationSchema.parse(raw);
  const db = getDb();
  const rs = reservationSettingsOf(tenant.settings);
  if (input.partySize > rs.maxPartySize) {
    throw new AppError(422, 'party_too_large', `Max ${rs.maxPartySize} people online`);
  }
  const loc = await resolveLocation(db, tenant.id, input.locationId);
  const start = DateTime.fromISO(input.startsAt).setZone(tenant.timezone);
  if (!sameInstant(await computeTableSlots(tenant, input.partySize, start.toISODate()!, DateTime.now(), { locationId: loc.id }), start)) {
    throw conflict('slot_unavailable', 'This time is no longer available');
  }
  const startsAt = start.toJSDate();
  const endsAt = start.plus({ minutes: rs.durationMin }).toJSDate();
  const service = await reservationService(db, tenant);

  const appt = await db.transaction(async (tx) => {
    await lockTenant(tx, tenant.id);
    let table;
    try {
      table = await assignTable(tx, tenant.id, input.partySize, startsAt, endsAt, { locationId: loc.id });
    } catch {
      throw conflict('slot_unavailable', 'This time is no longer available');
    }
    const customer = await findOrCreateCustomer(tx, tenant.id, input);
    const [row] = await tx
      .insert(appointments)
      .values({
        tenantId: tenant.id,
        customerId: customer.id,
        serviceId: service.id,
        startsAt,
        endsAt,
        priceCents: 0,
        source: 'online',
        notes: input.notes ?? null,
        partySize: input.partySize,
        tableId: table.id,
        locationId: loc.id,
      })
      .returning();
    return row!;
  });
  return result(tenant, appt, service.name, null);
}

/** Group class: takes `spots` places in a session if they still fit. */
async function bookClass(requestUrl: string, tenant: Tenant, raw: unknown): Promise<PublicBookingResult> {
  const input = publicClassBookingSchema.parse(raw);
  const db = getDb();
  const { appt, customer, serviceName, pro } = await db.transaction(async (tx) => {
    const { session, booked } = await lockSession(tx, tenant.id, input.classSessionId);
    if (session.status !== 'scheduled' || session.startsAt <= new Date()) {
      throw conflict('slot_unavailable', 'This class is no longer available');
    }
    assertRoom(session.capacity, booked, input.spots);
    const service = await tx.query.services.findFirst({ where: and(eq(services.id, session.serviceId), eq(services.tenantId, tenant.id)) });
    if (!service) throw notFound('service');
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
        professionalId: session.professionalId,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        partySize: input.spots,
        priceCents: service.priceCents * input.spots,
        locationId: session.locationId,
        source: 'online',
        notes: input.notes ?? null,
      })
      .returning();
    const pro = session.professionalId
      ? await tx.query.professionals.findFirst({ where: (p, { eq: e }) => e(p.id, session.professionalId!) })
      : null;
    return { appt: row!, customer, serviceName: service.name, pro };
  });
  return attachDeposit(requestUrl, tenant, result(tenant, appt, serviceName, pro?.name ?? null), appt, customer, serviceName);
}

/** Space rental: a space (or any free one) for one of the allowed durations; price by the hour. */
async function bookSpace(requestUrl: string, tenant: Tenant, raw: unknown): Promise<PublicBookingResult> {
  const input = publicRentalSchema.parse(raw);
  if (!rentalSettingsOf(tenant.settings).durations.includes(input.durationMin)) {
    throw new AppError(422, 'invalid_duration', 'That duration is not offered');
  }
  const db = getDb();
  const start = DateTime.fromISO(input.startsAt).setZone(tenant.timezone);
  // A chosen space decides the location.
  const chosen = input.spaceId ? (await activeSpaces(db, tenant.id)).find((x) => x.id === input.spaceId) : null;
  if (input.spaceId && !chosen) throw notFound('space');
  const loc = await resolveLocation(db, tenant.id, chosen?.locationId ?? input.locationId);
  const slots = await computeSpaceSlots(tenant, input.durationMin, start.toISODate()!, DateTime.now(), { spaceId: input.spaceId, locationId: loc.id });
  if (!sameInstant(slots, start)) throw conflict('slot_unavailable', 'This time is no longer available');
  const startsAt = start.toJSDate();
  const endsAt = start.plus({ minutes: input.durationMin }).toJSDate();
  const service = await internalService(db, tenant, RENTAL_SERVICE_NAME, 60);

  const { appt, customer, space } = await db.transaction(async (tx) => {
    await lockTenant(tx, tenant.id);
    let space;
    try {
      space = await assignSpace(tx, tenant.id, startsAt, endsAt, { spaceId: input.spaceId, locationId: loc.id });
    } catch {
      throw conflict('slot_unavailable', 'This time is no longer available');
    }
    const customer = await findOrCreateCustomer(tx, tenant.id, input);
    const [row] = await tx
      .insert(appointments)
      .values({
        tenantId: tenant.id,
        customerId: customer.id,
        serviceId: service.id,
        spaceId: space.id,
        locationId: loc.id,
        startsAt,
        endsAt,
        priceCents: spacePriceCents(space.pricePerHourCents, input.durationMin),
        source: 'online',
        notes: input.notes ?? null,
      })
      .returning();
    return { appt: row!, customer, space };
  });
  return attachDeposit(requestUrl, tenant, result(tenant, appt, space.name, space.name), appt, customer, `${space.name} (${input.durationMin} min)`);
}

/** Service appointment, with a specific professional or whoever is free. */
async function bookService(requestUrl: string, tenant: Tenant, raw: unknown): Promise<PublicBookingResult> {
  const input = publicBookingSchema.parse(raw);
  const db = getDb();
  const service = await db.query.services.findFirst({
    where: and(eq(services.id, input.serviceId), eq(services.tenantId, tenant.id), eq(services.active, true)),
  });
  if (!service) throw notFound('service');
  // A chosen professional decides the location.
  const chosen = input.professionalId ? (await activeProfessionals(db, tenant.id)).find((p) => p.id === input.professionalId) : null;
  if (input.professionalId && !chosen) throw notFound('professional');
  const loc = await resolveLocation(db, tenant.id, chosen?.locationId ?? input.locationId);

  const start = DateTime.fromISO(input.startsAt).setZone(tenant.timezone);
  const slots = await computeSlots(tenant, service.durationMin, start.toISODate()!, DateTime.now(), {
    serviceId: service.id,
    professionalId: input.professionalId,
    locationId: loc.id,
  });
  if (!sameInstant(slots, start)) throw conflict('slot_unavailable', 'This time is no longer available');
  const startsAt = start.toJSDate();
  const endsAt = start.plus({ minutes: service.durationMin }).toJSDate();

  const { appt, customer, pro } = await db.transaction(async (tx) => {
    // Lock the tenant row so two simultaneous bookings can't take the same slot.
    await lockTenant(tx, tenant.id);
    let pro = null;
    if ((await activeProfessionals(tx, tenant.id, loc.id)).length) {
      try {
        pro = await assignProfessional(tx, tenant.id, service.id, startsAt, endsAt, { professionalId: input.professionalId, locationId: loc.id });
      } catch {
        throw conflict('slot_unavailable', 'This time is no longer available');
      }
    } else if (await hasOverlap(tx, tenant.id, startsAt, endsAt, { locationId: loc.id })) {
      throw conflict('slot_unavailable', 'This time is no longer available');
    }
    const customer = await findOrCreateCustomer(tx, tenant.id, input);
    const [row] = await tx
      .insert(appointments)
      .values({
        tenantId: tenant.id,
        customerId: customer.id,
        serviceId: service.id,
        professionalId: pro?.id ?? null,
        locationId: loc.id,
        startsAt,
        endsAt,
        priceCents: service.priceCents,
        source: 'online',
        notes: input.notes ?? null,
      })
      .returning();
    return { appt: row!, customer, pro };
  });
  return attachDeposit(requestUrl, tenant, result(tenant, appt, service.name, pro?.name ?? null), appt, customer, service.name);
}

publicRoutes.post('/public/:slug/bookings', async (c) => {
  const tenant = await getTenantBySlug(c.req.param('slug'));
  const body = await c.req.json();
  switch (businessKind(tenant.businessType)) {
    case 'reservations':
      return c.json(await bookTable(tenant, body), 201);
    case 'classes':
      return c.json(await bookClass(c.req.url, tenant, body), 201);
    case 'rentals':
      return c.json(await bookSpace(c.req.url, tenant, body), 201);
    default:
      return c.json(await bookService(c.req.url, tenant, body), 201);
  }
});
