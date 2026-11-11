import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import {
  businessKind,
  kindConfig,
  manageRescheduleSchema,
  selfServiceOf,
  type Locale,
  type ManageAppointmentDto,
} from '@agenda/shared';
import { getDb } from '../db/client.js';
import { appointments, customers, locations, resources, reviews, services, tenants, type Appointment, type Location, type Service, type Tenant } from '../db/schema.js';
import { hasOverlap } from '../lib/appointments.js';
import { assertRoom, lockSession } from '../lib/classes.js';
import { verifyManageToken } from '../lib/crypto.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { activeResources, assignResource, locationBlocks } from '../lib/resources.js';
import { computeClassSlots, computeSlots, publicPlans } from './public.js';
import { notifyAppointment } from '../lib/notify.js';

/**
 * Customer self-service via the private link /c/<token> (sent after booking or by the business).
 * The token is an HMAC of the appointment id, so it can't be guessed or reused for another
 * appointment. Only the customer's first name and the appointment itself are exposed.
 */
export const manageRoutes = new Hono();

type Loaded = { appt: Appointment; tenant: Tenant; service: Service; customerName: string; resourceName: string | null; location: Location | null };
/** The resource a moved booking must keep (kinds where customers choose who/what), else any that fits. */
const keptResource = (l: Loaded) =>
  kindConfig(businessKind(l.tenant.businessType)).keepResourceOnReschedule ? l.appt.resourceId : null;
const durationOf = (a: Appointment) => Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / 60000);

/** Free start times for moving this booking, following the rules of its kind. */
async function slotsFor(l: Loaded, date: string, minStart: DateTime): Promise<string[]> {
  const { appt, tenant } = l;
  if (appt.classSessionId) {
    const list = await computeClassSlots(tenant, date, minStart, {
      serviceId: appt.serviceId,
      spots: appt.partySize ?? 1,
      excludeSessionId: appt.classSessionId,
      locationId: appt.locationId,
    });
    return list.map((s) => s.startsAt);
  }
  return computeSlots(tenant, durationOf(appt), date, minStart, {
    excludeId: appt.id,
    serviceId: appt.serviceId,
    partySize: appt.partySize,
    resourceId: keptResource(l),
    locationId: appt.locationId,
  });
}

async function load(token: string): Promise<Loaded> {
  const id = verifyManageToken(token);
  if (!id) throw notFound('appointment');
  const db = getDb();
  const appt = await db.query.appointments.findFirst({ where: eq(appointments.id, id) });
  if (!appt) throw notFound('appointment');
  const [tenant, service, customer] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, appt.tenantId) }),
    db.query.services.findFirst({ where: and(eq(services.id, appt.serviceId), eq(services.tenantId, appt.tenantId)) }),
    db.query.customers.findFirst({ where: and(eq(customers.id, appt.customerId), eq(customers.tenantId, appt.tenantId)) }),
  ]);
  if (!tenant || !service || !customer) throw notFound('appointment');
  const resource = appt.resourceId
    ? await db.query.resources.findFirst({ where: and(eq(resources.id, appt.resourceId), eq(resources.tenantId, appt.tenantId)) })
    : null;
  const location = (await db.query.locations.findFirst({ where: and(eq(locations.id, appt.locationId), eq(locations.tenantId, appt.tenantId)) })) ?? null;
  return { appt, tenant, service, customerName: customer.name, resourceName: resource?.name ?? null, location };
}

/** Business rules for what the customer may change right now. */
export function policy(appt: Pick<Appointment, 'status' | 'startsAt'>, tenant: Pick<Tenant, 'settings'>, now: DateTime = DateTime.now()) {
  const ss = selfServiceOf(tenant.settings);
  const start = DateTime.fromJSDate(appt.startsAt);
  const deadline = start.minus({ hours: ss.minHoursNotice });
  let reason: ManageAppointmentDto['reason'] = null;
  if (!ss.rescheduleEnabled && !ss.cancelEnabled) reason = 'disabled';
  else if (!['scheduled', 'confirmed'].includes(appt.status)) reason = 'not_active';
  else if (start <= now) reason = 'past';
  else if (now > deadline) reason = 'too_late';
  const open = reason === null;
  return {
    ss,
    deadline,
    reason,
    canReschedule: open && ss.rescheduleEnabled,
    canCancel: open && ss.cancelEnabled,
  };
}

function toDto({ appt, tenant, service, customerName, resourceName, location }: Loaded): ManageAppointmentDto {
  const p = policy(appt, tenant);
  return {
    business: {
      name: tenant.name,
      slug: tenant.slug,
      timezone: tenant.timezone,
      locale: tenant.locale as Locale,
      phone: location?.phone ?? tenant.phone,
      hours: location?.hours ?? tenant.settings.hours,
      kind: businessKind(tenant.businessType),
    },
    appointment: {
      id: appt.id,
      serviceName: service.name,
      durationMin: Math.round((appt.endsAt.getTime() - appt.startsAt.getTime()) / 60000),
      startsAt: appt.startsAt.toISOString(),
      status: appt.status,
      customerFirstName: customerName.trim().split(/\s+/)[0] ?? '',
      partySize: appt.partySize,
      resourceName,
    },
    canReschedule: p.canReschedule,
    canCancel: p.canCancel,
    changeDeadline: p.reason === 'disabled' ? null : p.deadline.toISO(),
    minHoursNotice: p.ss.minHoursNotice,
    reason: p.reason,
    reviewPath: null,
    reviewed: false,
    plans: [],
  };
}

const stamp = (tenant: Tenant, what: string) =>
  `[${DateTime.now().setZone(tenant.timezone).toFormat('yyyy-MM-dd HH:mm')}] ${what}`;
const appendNote = (notes: string | null, line: string) => (notes ? `${notes}\n${line}` : line);

manageRoutes.get('/public/manage/:token', async (c) => {
  const token = c.req.param('token');
  const loaded = await load(token);
  const reviewed = Boolean(await getDb().query.reviews.findFirst({ where: eq(reviews.appointmentId, loaded.appt.id) }));
  return c.json({
    ...toDto(loaded),
    reviewPath: loaded.appt.status === 'completed' ? `/r/${token}` : null,
    reviewed,
    plans: await publicPlans(loaded.tenant, loaded.appt.customerId),
  });
});

manageRoutes.get('/public/manage/:token/availability', async (c) => {
  const l = await load(c.req.param('token'));
  const date = c.req.query('date');
  if (!date) throw new AppError(400, 'missing_params', 'date required');
  if (!policy(l.appt, l.tenant).canReschedule) return c.json({ slots: [] });
  const minStart = DateTime.now().plus({ hours: selfServiceOf(l.tenant.settings).minHoursNotice });
  const slots = await slotsFor(l, date, minStart);
  return c.json({ slots: slots.filter((s) => DateTime.fromISO(s).toMillis() !== l.appt.startsAt.getTime()) });
});

manageRoutes.post('/public/manage/:token/reschedule', async (c) => {
  const l = await load(c.req.param('token'));
  const p = policy(l.appt, l.tenant);
  if (!p.canReschedule) throw new AppError(422, p.reason === 'too_late' ? 'too_late' : 'reschedule_not_allowed');
  const input = manageRescheduleSchema.parse(await c.req.json());

  const start = DateTime.fromISO(input.startsAt).setZone(l.tenant.timezone);
  const minStart = DateTime.now().plus({ hours: p.ss.minHoursNotice });
  let targetSession: string | null = null;
  if (l.appt.classSessionId) {
    const list = await computeClassSlots(l.tenant, start.toISODate()!, minStart, {
      serviceId: l.appt.serviceId,
      spots: l.appt.partySize ?? 1,
      excludeSessionId: l.appt.classSessionId,
      locationId: l.appt.locationId,
    });
    targetSession = list.find((s) => DateTime.fromISO(s.startsAt).toMillis() === start.toMillis())?.sessionId ?? null;
    if (!targetSession) throw conflict('slot_unavailable', 'This time is no longer available');
  } else {
    const slots = await slotsFor(l, start.toISODate()!, minStart);
    if (!slots.some((s) => DateTime.fromISO(s).toMillis() === start.toMillis())) {
      throw conflict('slot_unavailable', 'This time is no longer available');
    }
  }
  let startsAt = start.toJSDate();
  let endsAt = start.plus({ minutes: durationOf(l.appt) }).toJSDate();
  const previous = DateTime.fromJSDate(l.appt.startsAt).setZone(l.tenant.timezone).toFormat('yyyy-MM-dd HH:mm');

  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select id from tenants where id = ${l.tenant.id} for update`);
    let resourceId = l.appt.resourceId;
    let classSessionId = l.appt.classSessionId;
    if (targetSession) {
      const { session, booked } = await lockSession(tx, l.tenant.id, targetSession);
      if (session.status !== 'scheduled') throw conflict('slot_unavailable', 'This class is no longer available');
      try {
        assertRoom(session.capacity, booked, l.appt.partySize ?? 1);
      } catch {
        throw conflict('slot_unavailable', 'This class is full');
      }
      classSessionId = session.id;
      resourceId = session.resourceId;
      startsAt = session.startsAt;
      endsAt = session.endsAt;
    } else if ((await activeResources(tx, l.tenant.id, l.appt.locationId)).length) {
      try {
        resourceId = (await assignResource(tx, l.tenant.id, startsAt, endsAt, {
          resourceId: keptResource(l),
          serviceId: l.appt.serviceId,
          partySize: l.appt.partySize,
          excludeId: l.appt.id,
          locationId: l.appt.locationId,
        })).id;
      } catch {
        throw conflict('slot_unavailable', 'This time is no longer available');
      }
    } else if (
      (await hasOverlap(tx, l.tenant.id, startsAt, endsAt, { excludeId: l.appt.id, locationId: l.appt.locationId })) ||
      (await locationBlocks(tx, l.tenant.id, startsAt, endsAt, l.appt.locationId)).length
    ) {
      throw conflict('slot_unavailable', 'This time is no longer available');
    }
    // Status is re-read under the lock so a concurrent cancel can't be undone.
    const res = await tx
      .update(appointments)
      .set({
        startsAt,
        endsAt,
        status: 'scheduled',
        reminderSentAt: null,
        resourceId,
        classSessionId,
        notes: appendNote(l.appt.notes, stamp(l.tenant, `Reagendada por el cliente (antes: ${previous})`)),
      })
      .where(
        and(
          eq(appointments.id, l.appt.id),
          eq(appointments.tenantId, l.tenant.id),
          sql`${appointments.status} in ('scheduled', 'confirmed')`,
        ),
      )
      .returning({ id: appointments.id });
    if (res.length === 0) throw new AppError(422, 'reschedule_not_allowed');
  });
  await notifyAppointment(l.appt.id, 'rescheduled');
  return c.json(toDto(await load(c.req.param('token'))));
});

manageRoutes.post('/public/manage/:token/cancel', async (c) => {
  const l = await load(c.req.param('token'));
  const p = policy(l.appt, l.tenant);
  if (!p.canCancel) throw new AppError(422, p.reason === 'too_late' ? 'too_late' : 'cancel_not_allowed');
  await getDb()
    .update(appointments)
    .set({ status: 'cancelled', notes: appendNote(l.appt.notes, stamp(l.tenant, 'Cancelada por el cliente')) })
    .where(
      and(
        eq(appointments.id, l.appt.id),
        eq(appointments.tenantId, l.tenant.id),
        sql`${appointments.status} in ('scheduled', 'confirmed')`,
      ),
    );
  await notifyAppointment(l.appt.id, 'cancelled');
  return c.json(toDto(await load(c.req.param('token'))));
});
