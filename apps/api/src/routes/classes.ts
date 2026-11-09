import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { appointmentListQuerySchema, classSessionInputSchema, classSessionUpdateSchema } from '@agenda/shared';
import { getDb, type Db } from '../db/client.js';
import { appointments, classSessions, professionals, services, tenants } from '../db/schema.js';
import { queryAppointments } from '../lib/appointments.js';
import { instructorBusy, lockSession, querySessions } from '../lib/classes.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { getScope } from '../lib/access.js';
import { requireManager, type AppEnv } from '../middleware/auth.js';

/**
 * Group classes, created session by session (with "copy to next week").
 * Attendees are regular appointments linked to the session, so customers, payments,
 * reminders and reports keep working the same way.
 */
export const classRoutes = new Hono<AppEnv>();

const MIN = 60_000;

async function assertRefs(db: Db, tenantId: string, serviceId: string | undefined, professionalId: string | null | undefined) {
  const [svc, pro] = await Promise.all([
    serviceId ? db.query.services.findFirst({ where: and(eq(services.id, serviceId), eq(services.tenantId, tenantId)) }) : null,
    professionalId
      ? db.query.professionals.findFirst({ where: and(eq(professionals.id, professionalId), eq(professionals.tenantId, tenantId)) })
      : null,
  ]);
  if (serviceId && !svc) throw notFound('service');
  if (professionalId && !pro) throw notFound('professional');
  return svc;
}

async function one(db: Db, tenantId: string, id: string) {
  const [s] = await querySessions(db, tenantId, sql`cs.id = ${id}`);
  if (!s) throw notFound('class_session');
  return s;
}

classRoutes.get('/class-sessions', async (c) => {
  const { from, to } = appointmentListQuerySchema.parse(c.req.query());
  const db = getDb();
  const scope = await getScope(db, c);
  // Instructors see the classes they teach.
  const mine = scope.all ? sql`` : scope.professionalId ? sql`and cs.professional_id = ${scope.professionalId}` : sql`and false`;
  return c.json(await querySessions(db, c.get('tenantId'), sql`cs.starts_at >= ${from} and cs.starts_at < ${to} ${mine}`));
});

classRoutes.get('/class-sessions/:id', async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const session = await one(db, tenantId, c.req.param('id'));
  const scope = await getScope(db, c);
  if (!scope.all && session.professionalId !== scope.professionalId) throw notFound('class_session');
  const attendees = await queryAppointments(db, tenantId, sql`a.class_session_id = ${session.id}`, sql`order by c.name asc limit 1000`);
  return c.json({ session, attendees });
});

classRoutes.post('/class-sessions', requireManager, async (c) => {
  const input = classSessionInputSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  const db = getDb();
  const svc = (await assertRefs(db, tenantId, input.serviceId, input.professionalId))!;
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(startsAt.getTime() + (input.durationMin ?? svc.durationMin) * MIN);
  const id = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from tenants where id = ${tenantId} for update`);
    if (input.professionalId && !input.allowOverlap && (await instructorBusy(tx, tenantId, input.professionalId, startsAt, endsAt))) {
      throw conflict('instructor_busy', 'The instructor has another class or appointment at that time');
    }
    const [row] = await tx
      .insert(classSessions)
      .values({
        tenantId,
        serviceId: svc.id,
        professionalId: input.professionalId ?? null,
        startsAt,
        endsAt,
        capacity: input.capacity,
        notes: input.notes ?? null,
      })
      .returning({ id: classSessions.id });
    return row!.id;
  });
  return c.json(await one(db, tenantId, id), 201);
});

classRoutes.patch('/class-sessions/:id', requireManager, async (c) => {
  const input = classSessionUpdateSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const db = getDb();
  await assertRefs(db, tenantId, undefined, input.professionalId);
  await db.transaction(async (tx) => {
    const { session, booked } = await lockSession(tx, tenantId, id);
    if (session.status !== 'scheduled') throw new AppError(422, 'class_cancelled', 'The class was cancelled');
    const startsAt = input.startsAt ? new Date(input.startsAt) : session.startsAt;
    const duration = input.durationMin ?? (session.endsAt.getTime() - session.startsAt.getTime()) / MIN;
    const endsAt = new Date(startsAt.getTime() + duration * MIN);
    const capacity = input.capacity ?? session.capacity;
    if (capacity < booked) throw new AppError(422, 'capacity_below_booked', `${booked} spots are already taken`);
    const professionalId = input.professionalId === undefined ? session.professionalId : input.professionalId;
    const timeChanged = startsAt.getTime() !== session.startsAt.getTime() || endsAt.getTime() !== session.endsAt.getTime();
    if (professionalId && !input.allowOverlap && (timeChanged || professionalId !== session.professionalId) &&
        (await instructorBusy(tx, tenantId, professionalId, startsAt, endsAt, id))) {
      throw conflict('instructor_busy', 'The instructor has another class or appointment at that time');
    }
    await tx
      .update(classSessions)
      .set({ startsAt, endsAt, capacity, professionalId, notes: input.notes === undefined ? session.notes : input.notes })
      .where(and(eq(classSessions.id, id), eq(classSessions.tenantId, tenantId)));
    // Attendees follow the class (and get a fresh reminder if the time changed).
    await tx
      .update(appointments)
      .set({
        startsAt,
        endsAt,
        professionalId,
        ...(timeChanged ? { reminderSentAt: null } : {}),
      })
      .where(and(eq(appointments.classSessionId, id), eq(appointments.tenantId, tenantId)));
  });
  return c.json(await one(db, tenantId, id));
});

/** Cancels the class and every active booking in it. */
classRoutes.post('/class-sessions/:id/cancel', requireManager, async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const db = getDb();
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  const stamp = `[${DateTime.now().setZone(tenant?.timezone ?? 'America/Mexico_City').toFormat('yyyy-MM-dd HH:mm')}] Clase cancelada por el negocio`;
  await db.transaction(async (tx) => {
    await lockSession(tx, tenantId, id);
    await tx.update(classSessions).set({ status: 'cancelled' }).where(and(eq(classSessions.id, id), eq(classSessions.tenantId, tenantId)));
    await tx.execute(sql`
      update appointments set status = 'cancelled',
        notes = case when notes is null or notes = '' then ${stamp} else notes || E'\n' || ${stamp} end
      where class_session_id = ${id} and tenant_id = ${tenantId} and status in ('scheduled', 'confirmed')`);
  });
  return c.json(await one(db, tenantId, id));
});

/** Copies a class N days later (default: next week), without attendees. */
classRoutes.post('/class-sessions/:id/copy', requireManager, async (c) => {
  const tenantId = c.get('tenantId');
  const db = getDb();
  const body = (await c.req.json().catch(() => ({}))) as { days?: unknown };
  const days = Number.isInteger(body.days) && Number(body.days) >= 1 && Number(body.days) <= 365 ? Number(body.days) : 7;
  const src = await db.query.classSessions.findFirst({
    where: and(eq(classSessions.id, c.req.param('id')), eq(classSessions.tenantId, tenantId)),
  });
  if (!src) throw notFound('class_session');
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  const tz = tenant?.timezone ?? 'America/Mexico_City';
  // Same local wall-clock time even across DST changes.
  const startsAt = DateTime.fromJSDate(src.startsAt).setZone(tz).plus({ days }).toJSDate();
  const endsAt = new Date(startsAt.getTime() + (src.endsAt.getTime() - src.startsAt.getTime()));
  const id = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from tenants where id = ${tenantId} for update`);
    if (src.professionalId && (await instructorBusy(tx, tenantId, src.professionalId, startsAt, endsAt))) {
      throw conflict('instructor_busy', 'The instructor has another class or appointment at that time');
    }
    const [row] = await tx
      .insert(classSessions)
      .values({ tenantId, serviceId: src.serviceId, professionalId: src.professionalId, startsAt, endsAt, capacity: src.capacity, notes: src.notes })
      .returning({ id: classSessions.id });
    return row!.id;
  });
  return c.json(await one(db, tenantId, id), 201);
});

/** Only empty classes can be deleted; otherwise cancel them so history is kept. */
classRoutes.delete('/class-sessions/:id', requireManager, async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const db = getDb();
  const used = await db.query.appointments.findFirst({
    where: and(eq(appointments.tenantId, tenantId), eq(appointments.classSessionId, id)),
    columns: { id: true },
  });
  if (used) throw conflict('has_bookings', 'Cancel the class instead: it has bookings');
  const [row] = await db
    .delete(classSessions)
    .where(and(eq(classSessions.id, id), eq(classSessions.tenantId, tenantId)))
    .returning({ id: classSessions.id });
  if (!row) throw notFound('class_session');
  return c.body(null, 204);
});
