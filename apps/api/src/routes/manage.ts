import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import {
  manageRescheduleSchema,
  selfServiceOf,
  type Locale,
  type ManageAppointmentDto,
} from '@agenda/shared';
import { getDb } from '../db/client.js';
import { appointments, customers, services, tenants, type Appointment, type Service, type Tenant } from '../db/schema.js';
import { hasOverlap } from '../lib/appointments.js';
import { verifyManageToken } from '../lib/crypto.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { computeSlots } from './public.js';

/**
 * Customer self-service via the private link /c/<token> (sent after booking or by the business).
 * The token is an HMAC of the appointment id, so it can't be guessed or reused for another
 * appointment. Only the customer's first name and the appointment itself are exposed.
 */
export const manageRoutes = new Hono();

type Loaded = { appt: Appointment; tenant: Tenant; service: Service; customerName: string };

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
  return { appt, tenant, service, customerName: customer.name };
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

function toDto({ appt, tenant, service, customerName }: Loaded): ManageAppointmentDto {
  const p = policy(appt, tenant);
  return {
    business: {
      name: tenant.name,
      slug: tenant.slug,
      timezone: tenant.timezone,
      locale: tenant.locale as Locale,
      phone: tenant.phone,
      hours: tenant.settings.hours,
    },
    appointment: {
      id: appt.id,
      serviceName: service.name,
      durationMin: Math.round((appt.endsAt.getTime() - appt.startsAt.getTime()) / 60000),
      startsAt: appt.startsAt.toISOString(),
      status: appt.status,
      customerFirstName: customerName.trim().split(/\s+/)[0] ?? '',
    },
    canReschedule: p.canReschedule,
    canCancel: p.canCancel,
    changeDeadline: p.reason === 'disabled' ? null : p.deadline.toISO(),
    minHoursNotice: p.ss.minHoursNotice,
    reason: p.reason,
  };
}

const stamp = (tenant: Tenant, what: string) =>
  `[${DateTime.now().setZone(tenant.timezone).toFormat('yyyy-MM-dd HH:mm')}] ${what}`;
const appendNote = (notes: string | null, line: string) => (notes ? `${notes}\n${line}` : line);

manageRoutes.get('/public/manage/:token', async (c) => c.json(toDto(await load(c.req.param('token')))));

manageRoutes.get('/public/manage/:token/availability', async (c) => {
  const l = await load(c.req.param('token'));
  const date = c.req.query('date');
  if (!date) throw new AppError(400, 'missing_params', 'date required');
  if (!policy(l.appt, l.tenant).canReschedule) return c.json({ slots: [] });
  const minStart = DateTime.now().plus({ hours: selfServiceOf(l.tenant.settings).minHoursNotice });
  const durationMin = Math.round((l.appt.endsAt.getTime() - l.appt.startsAt.getTime()) / 60000);
  const slots = await computeSlots(l.tenant, durationMin, date, minStart, { excludeId: l.appt.id });
  return c.json({ slots: slots.filter((s) => DateTime.fromISO(s).toMillis() !== l.appt.startsAt.getTime()) });
});

manageRoutes.post('/public/manage/:token/reschedule', async (c) => {
  const l = await load(c.req.param('token'));
  const p = policy(l.appt, l.tenant);
  if (!p.canReschedule) throw new AppError(422, p.reason === 'too_late' ? 'too_late' : 'reschedule_not_allowed');
  const input = manageRescheduleSchema.parse(await c.req.json());

  const start = DateTime.fromISO(input.startsAt).setZone(l.tenant.timezone);
  const durationMin = Math.round((l.appt.endsAt.getTime() - l.appt.startsAt.getTime()) / 60000);
  const minStart = DateTime.now().plus({ hours: p.ss.minHoursNotice });
  const slots = await computeSlots(l.tenant, durationMin, start.toISODate()!, minStart, { excludeId: l.appt.id });
  if (!slots.some((s) => DateTime.fromISO(s).toMillis() === start.toMillis())) {
    throw conflict('slot_unavailable', 'This time is no longer available');
  }
  const startsAt = start.toJSDate();
  const endsAt = start.plus({ minutes: durationMin }).toJSDate();
  const previous = DateTime.fromJSDate(l.appt.startsAt).setZone(l.tenant.timezone).toFormat('yyyy-MM-dd HH:mm');

  await getDb().transaction(async (tx) => {
    await tx.execute(sql`select id from tenants where id = ${l.tenant.id} for update`);
    if (await hasOverlap(tx, l.tenant.id, startsAt, endsAt, { excludeId: l.appt.id })) {
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
  return c.json(toDto(await load(c.req.param('token'))));
});
