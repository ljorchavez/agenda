import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import {
  appointmentCreateSchema,
  appointmentListQuerySchema,
  appointmentUpdateSchema,
  bookingPriceCents,
  businessKind,
  kindConfig,
  rentalSettingsOf,
  type BusinessKind,
} from '@agenda/shared';
import { getDb } from '../db/client.js';
import { appointments, customers, memberships, payments, services, tenants, type Resource, type Service } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { hasOverlap, queryAppointments } from '../lib/appointments.js';
import { assertRoom, lockSession } from '../lib/classes.js';
import { activeResources, assignResource, defaultService, findResource } from '../lib/resources.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { assertLocation, forbiddenScope, getScope, inScope, scopeSql } from '../lib/access.js';
import { locationForWrite } from '../lib/locations.js';
import { assertCanAddBooking } from '../lib/plan.js';
import { requireManager, type AppEnv } from '../middleware/auth.js';

export const appointmentRoutes = new Hono<AppEnv>();

const MIN = 60_000;
const ACTIVE = new Set(['scheduled', 'confirmed']);

/** A staff member assigned to an appointment must belong to the same tenant. */
async function assertStaffInTenant(db: Db, tenantId: string, staffUserId: string | null | undefined) {
  if (!staffUserId) return;
  const staff = await db.query.memberships.findFirst({
    where: and(eq(memberships.userId, staffUserId), eq(memberships.tenantId, tenantId)),
    columns: { id: true },
  });
  if (!staff) throw notFound('staff');
}

async function tenantKind(db: Db, tenantId: string) {
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!t) throw notFound('tenant');
  return { tenant: t, kind: businessKind(t.businessType) as BusinessKind };
}

/** Serializes writes per tenant so two requests can't take the same slot. */
const lockTenant = (tx: Pick<Db, 'execute'>, tenantId: string) =>
  tx.execute(sql`select id from tenants where id = ${tenantId} for update`);

/**
 * Validates or picks the resource for [start, end) — same rules for every kind of business.
 * Without resources in the location it works as a single agenda (no double booking).
 * `allowOverlap` keeps the requested resource (or none) without checking availability.
 */
async function resolveResource(
  tx: Db,
  tenantId: string,
  start: Date,
  end: Date,
  o: { resourceId: string | null; serviceId: string; partySize: number | null; allowOverlap?: boolean; excludeId?: string; locationId: string; staffUserId: string | null },
): Promise<Resource | null> {
  if (o.allowOverlap) return o.resourceId ? findResource(tx, tenantId, o.resourceId) : null;
  if ((await activeResources(tx, tenantId, o.locationId)).length) {
    return assignResource(tx, tenantId, start, end, {
      resourceId: o.resourceId,
      serviceId: o.serviceId,
      partySize: o.partySize,
      excludeId: o.excludeId,
      locationId: o.locationId,
    });
  }
  if (await hasOverlap(tx, tenantId, start, end, { staffUserId: o.staffUserId, excludeId: o.excludeId, locationId: o.locationId })) {
    throw conflict('overlap', 'The time slot overlaps another appointment');
  }
  return null;
}

appointmentRoutes.get('/appointments', async (c) => {
  const { from, to } = appointmentListQuerySchema.parse(c.req.query());
  const db = getDb();
  const scope = await getScope(db, c);
  const rows = await queryAppointments(
    db,
    c.get('tenantId'),
    sql`a.starts_at >= ${from} and a.starts_at < ${to} ${scopeSql(scope)}`,
  );
  return c.json(rows);
});

appointmentRoutes.get('/appointments/:id', async (c) => {
  const db = getDb();
  const scope = await getScope(db, c);
  const [row] = await queryAppointments(
    db,
    c.get('tenantId'),
    sql`a.id = ${c.req.param('id')} ${scopeSql(scope)}`,
  );
  if (!row) throw notFound('appointment');
  return c.json(row);
});

appointmentRoutes.post('/appointments', async (c) => {
  const input = appointmentCreateSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  const db = getDb();
  const { tenant, kind } = await tenantKind(db, tenantId);
  const cfg = kindConfig(kind);

  const customer = await db.query.customers.findFirst({
    where: and(eq(customers.id, input.customerId), eq(customers.tenantId, tenantId)),
  });
  if (!customer) throw notFound('customer');
  await assertStaffInTenant(db, tenantId, input.staffUserId);
  const chosen = input.resourceId ? await findResource(db, tenantId, input.resourceId) : null;

  // Team members book only into their own agenda.
  const scope = await getScope(db, c);
  if (scope.personal) {
    if (input.resourceId && input.resourceId !== scope.resourceId) throw forbiddenScope();
    if (input.staffUserId && input.staffUserId !== scope.userId) throw forbiddenScope();
    input.allowOverlap = false;
    input.resourceId = scope.resourceId;
  }

  let service: Service | undefined;
  if (input.serviceId) {
    service = await db.query.services.findFirst({ where: and(eq(services.id, input.serviceId), eq(services.tenantId, tenantId)) });
    if (!service) throw notFound('service');
  } else if (cfg.durations || cfg.partySize) {
    service = await defaultService(db, tenant, kind);
  } else if (!input.classSessionId) {
    throw new AppError(422, 'service_required', 'serviceId is required');
  }
  // A booking happens where its resource is; class sign-ups take the session's (checked below).
  const locationId = input.classSessionId
    ? undefined
    : (await locationForWrite(db, c, chosen?.locationId ?? input.locationId, { create: true }))!;

  const row = await db.transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    await assertCanAddBooking(tx, tenantId);
    const base = {
      tenantId,
      customerId: customer.id,
      staffUserId: input.staffUserId ?? null,
      notes: input.notes ?? null,
      source: 'staff' as const,
    };

    // Classes: add the customer to a session if there's room.
    if (input.classSessionId) {
      const { session, booked } = await lockSession(tx, tenantId, input.classSessionId);
      if (scope.personal && session.resourceId !== scope.resourceId) throw forbiddenScope();
      assertLocation(scope, session.locationId);
      if (session.status !== 'scheduled') throw new AppError(422, 'class_cancelled', 'The class was cancelled');
      const spots = input.partySize ?? 1;
      if (!input.allowOverlap) assertRoom(session.capacity, booked, spots);
      const svc = await tx.query.services.findFirst({ where: and(eq(services.id, session.serviceId), eq(services.tenantId, tenantId)) });
      const [inserted] = await tx
        .insert(appointments)
        .values({
          ...base,
          serviceId: session.serviceId,
          classSessionId: session.id,
          resourceId: session.resourceId,
          startsAt: session.startsAt,
          endsAt: session.endsAt,
          partySize: spots,
          priceCents: input.priceCents ?? (svc?.priceCents ?? 0) * spots,
          locationId: session.locationId,
        })
        .returning({ id: appointments.id });
      return inserted!;
    }

    const svc = service!;
    const startsAt = new Date(input.startsAt!);
    const durationMin = input.durationMin ?? (cfg.durations ? rentalSettingsOf(tenant.settings).durations[0]! : svc.durationMin);
    const endsAt = new Date(startsAt.getTime() + durationMin * MIN);
    const partySize = cfg.partySize ? (input.partySize ?? 2) : (input.partySize ?? null);
    const resource = await resolveResource(tx, tenantId, startsAt, endsAt, {
      resourceId: input.resourceId ?? null,
      serviceId: svc.id,
      partySize,
      allowOverlap: input.allowOverlap,
      locationId: locationId!,
      staffUserId: input.staffUserId ?? null,
    });
    const [inserted] = await tx
      .insert(appointments)
      .values({
        ...base,
        serviceId: svc.id,
        resourceId: resource?.id ?? null,
        locationId,
        startsAt,
        endsAt,
        partySize,
        priceCents: input.priceCents ?? bookingPriceCents(resource, svc.priceCents, durationMin),
      })
      .returning({ id: appointments.id });
    return inserted!;
  });

  const [dto] = await queryAppointments(db, tenantId, sql`a.id = ${row.id}`);
  return c.json(dto, 201);
});

appointmentRoutes.patch('/appointments/:id', async (c) => {
  const input = appointmentUpdateSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const db = getDb();

  const current = await db.query.appointments.findFirst({
    where: and(eq(appointments.id, id), eq(appointments.tenantId, tenantId)),
  });
  if (!current) throw notFound('appointment');
  const scope = await getScope(db, c);
  if (!inScope(scope, current)) throw notFound('appointment');
  if (scope.personal) {
    // Team members can't hand a booking to someone else.
    if (input.resourceId !== undefined && input.resourceId !== current.resourceId) throw forbiddenScope();
    if (input.staffUserId !== undefined && input.staffUserId !== current.staffUserId) throw forbiddenScope();
    if (input.allowOverlap) input.allowOverlap = false;
  }
  const { kind } = await tenantKind(db, tenantId);
  const cfg = kindConfig(kind);
  const isClass = Boolean(current.classSessionId);

  // Class attendees follow their session's time; move the class itself instead.
  const startsAt = input.startsAt && !isClass ? new Date(input.startsAt) : current.startsAt;
  const duration = isClass
    ? (current.endsAt.getTime() - current.startsAt.getTime()) / MIN
    : input.durationMin ?? (current.endsAt.getTime() - current.startsAt.getTime()) / MIN;
  const endsAt = new Date(startsAt.getTime() + duration * MIN);
  const timeChanged =
    startsAt.getTime() !== current.startsAt.getTime() ||
    endsAt.getTime() !== current.endsAt.getTime();
  const staffUserId =
    input.staffUserId === undefined ? current.staffUserId : input.staffUserId;
  if (input.staffUserId !== undefined) await assertStaffInTenant(db, tenantId, staffUserId);
  if (input.resourceId) await findResource(db, tenantId, input.resourceId);
  const nextStatus = input.status ?? current.status;
  const reactivated = ACTIVE.has(nextStatus) && !ACTIVE.has(current.status);
  const partySize = input.partySize ?? current.partySize ?? (cfg.partySize && !isClass ? 2 : null);
  const resourceChanged = input.resourceId !== undefined && input.resourceId !== current.resourceId;
  const needsCheck =
    ACTIVE.has(nextStatus) &&
    !input.allowOverlap &&
    (timeChanged || reactivated || resourceChanged || partySize !== current.partySize || staffUserId !== current.staffUserId);

  await db.transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    let resourceId = input.resourceId === undefined ? current.resourceId : input.resourceId;
    let price = input.priceCents ?? current.priceCents;

    if (isClass) {
      if (needsCheck) {
        const { session, booked } = await lockSession(tx, tenantId, current.classSessionId!, id);
        assertRoom(session.capacity, booked, partySize ?? 1);
      }
    } else if (needsCheck) {
      const opts = {
        serviceId: current.serviceId,
        partySize,
        excludeId: id,
        locationId: current.locationId,
        staffUserId,
      };
      let resource: Resource | null;
      if (resourceChanged || !resourceId) {
        resource = await resolveResource(tx, tenantId, startsAt, endsAt, { ...opts, resourceId: input.resourceId ?? null });
      } else {
        // Keep the current resource if it still works; otherwise pick another one.
        try {
          resource = await resolveResource(tx, tenantId, startsAt, endsAt, { ...opts, resourceId });
        } catch (err) {
          if (!(err instanceof AppError) || err.status === 404) throw err;
          resource = await resolveResource(tx, tenantId, startsAt, endsAt, { ...opts, resourceId: null });
        }
      }
      // Hourly-priced bookings are re-priced when their length or resource changes, unless a price was given.
      if (input.priceCents === undefined && resource?.pricePerHourCents && (timeChanged || resource.id !== current.resourceId)) {
        price = bookingPriceCents(resource, price, duration);
      }
      if (resource) resourceId = resource.id;
    }

    await tx
      .update(appointments)
      .set({
        startsAt,
        endsAt,
        staffUserId,
        status: nextStatus,
        priceCents: price,
        notes: input.notes === undefined ? current.notes : input.notes,
        partySize,
        resourceId,
        // Rescheduling re-arms the reminder.
        reminderSentAt: timeChanged ? null : current.reminderSentAt,
      })
      .where(and(eq(appointments.id, id), eq(appointments.tenantId, tenantId)));

    if (input.status === 'completed' && input.paymentMethod) {
      const paid = await tx.execute<{ total: string | null }>(sql`
        select sum(amount_cents) as total from payments
        where appointment_id = ${id} and tenant_id = ${tenantId} and status = 'paid'`);
      const outstanding = price - Number(paid.rows[0]?.total ?? 0);
      if (outstanding > 0) {
        await tx.insert(payments).values({
          tenantId,
          customerId: current.customerId,
          appointmentId: id,
          amountCents: outstanding,
          method: input.paymentMethod,
          status: 'paid',
          paidAt: new Date(),
        });
      }
    }
  });

  const [dto] = await queryAppointments(db, tenantId, sql`a.id = ${id}`);
  return c.json(dto);
});

appointmentRoutes.delete('/appointments/:id', requireManager, async (c) => {
  const db = getDb();
  const current = await db.query.appointments.findFirst({
    where: and(eq(appointments.id, c.req.param('id')), eq(appointments.tenantId, c.get('tenantId'))),
  });
  if (!current || !inScope(await getScope(db, c), current)) throw notFound('appointment');
  const [row] = await db
    .delete(appointments)
    .where(
      and(eq(appointments.id, c.req.param('id')), eq(appointments.tenantId, c.get('tenantId'))),
    )
    .returning({ id: appointments.id });
  if (!row) throw notFound('appointment');
  return c.body(null, 204);
});
