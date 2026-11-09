import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import {
  appointmentCreateSchema,
  appointmentListQuerySchema,
  appointmentUpdateSchema,
  businessKind,
  rentalSettingsOf,
  spacePriceCents,
  type BusinessKind,
} from '@agenda/shared';
import { getDb } from '../db/client.js';
import { appointments, customers, payments, professionals, services, tenants, users, type Service } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { hasOverlap, queryAppointments } from '../lib/appointments.js';
import { assertRoom, lockSession } from '../lib/classes.js';
import { activeProfessionals, assignProfessional, assignSpace, internalService, RENTAL_SERVICE_NAME } from '../lib/resources.js';
import { assignTable } from '../lib/tables.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { forbiddenScope, getScope, inScope, scopeSql } from '../lib/access.js';
import { requireManager, type AppEnv } from '../middleware/auth.js';

export const appointmentRoutes = new Hono<AppEnv>();

const MIN = 60_000;
const ACTIVE = new Set(['scheduled', 'confirmed']);

/** A staff member assigned to an appointment must belong to the same tenant. */
async function assertStaffInTenant(db: Db, tenantId: string, staffUserId: string | null | undefined) {
  if (!staffUserId) return;
  const staff = await db.query.users.findFirst({
    where: and(eq(users.id, staffUserId), eq(users.tenantId, tenantId)),
    columns: { id: true },
  });
  if (!staff) throw notFound('staff');
}

async function assertProfessionalInTenant(db: Pick<Db, 'query'>, tenantId: string, id: string | null | undefined) {
  if (!id) return;
  const p = await db.query.professionals.findFirst({ where: and(eq(professionals.id, id), eq(professionals.tenantId, tenantId)), columns: { id: true } });
  if (!p) throw notFound('professional');
}

async function tenantKind(db: Db, tenantId: string) {
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!t) throw notFound('tenant');
  return { tenant: t, kind: businessKind(t.businessType) as BusinessKind };
}

/** Serializes writes per tenant so two requests can't take the same slot. */
const lockTenant = (tx: Pick<Db, 'execute'>, tenantId: string) =>
  tx.execute(sql`select id from tenants where id = ${tenantId} for update`);

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

  const customer = await db.query.customers.findFirst({
    where: and(eq(customers.id, input.customerId), eq(customers.tenantId, tenantId)),
  });
  if (!customer) throw notFound('customer');
  await assertStaffInTenant(db, tenantId, input.staffUserId);
  await assertProfessionalInTenant(db, tenantId, input.professionalId);

  // Team members book only into their own agenda.
  const scope = await getScope(db, c);
  if (!scope.all) {
    if (input.professionalId && input.professionalId !== scope.professionalId) throw forbiddenScope();
    if (input.staffUserId && input.staffUserId !== scope.userId) throw forbiddenScope();
    input.allowOverlap = false;
    if (scope.professionalId) input.professionalId = scope.professionalId;
    else input.staffUserId = scope.userId;
  }

  let service: Service | undefined;
  if (input.serviceId) {
    service = await db.query.services.findFirst({ where: and(eq(services.id, input.serviceId), eq(services.tenantId, tenantId)) });
    if (!service) throw notFound('service');
  } else if (kind === 'rentals') {
    service = await internalService(db, tenant, RENTAL_SERVICE_NAME, 60);
  } else if (!input.classSessionId) {
    throw new AppError(422, 'service_required', 'serviceId is required');
  }

  const row = await db.transaction(async (tx) => {
    await lockTenant(tx, tenantId);
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
      if (!scope.all && session.professionalId !== scope.professionalId) throw forbiddenScope();
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
          professionalId: session.professionalId,
          startsAt: session.startsAt,
          endsAt: session.endsAt,
          partySize: spots,
          priceCents: input.priceCents ?? (svc?.priceCents ?? 0) * spots,
        })
        .returning({ id: appointments.id });
      return inserted!;
    }

    const svc = service!;
    const startsAt = new Date(input.startsAt!);

    // Rentals: a space for a duration, priced by the hour.
    if (kind === 'rentals') {
      const durationMin = input.durationMin ?? rentalSettingsOf(tenant.settings).durations[0]!;
      const endsAt = new Date(startsAt.getTime() + durationMin * MIN);
      const space = input.spaceId || !input.allowOverlap
        ? await assignSpace(tx, tenantId, startsAt, endsAt, input.allowOverlap ? {} : { spaceId: input.spaceId })
        : null;
      const [inserted] = await tx
        .insert(appointments)
        .values({
          ...base,
          serviceId: svc.id,
          spaceId: input.allowOverlap ? (input.spaceId ?? null) : space!.id,
          startsAt,
          endsAt,
          priceCents: input.priceCents ?? (space ? spacePriceCents(space.pricePerHourCents, durationMin) : 0),
        })
        .returning({ id: appointments.id });
      return inserted!;
    }

    const endsAt = new Date(startsAt.getTime() + (input.durationMin ?? svc.durationMin) * MIN);

    // Restaurants: tables for a party.
    if (kind === 'reservations') {
      const partySize = input.partySize ?? 2;
      let tableId: string | null = null;
      // Explicit table is always validated; otherwise auto-assign unless overlap is allowed.
      if (input.tableId || !input.allowOverlap) {
        tableId = (await assignTable(tx, tenantId, partySize, startsAt, endsAt, { tableId: input.tableId })).id;
      }
      const [inserted] = await tx
        .insert(appointments)
        .values({ ...base, serviceId: svc.id, startsAt, endsAt, priceCents: input.priceCents ?? svc.priceCents, partySize, tableId })
        .returning({ id: appointments.id });
      return inserted!;
    }

    // Services: per-professional agendas when the business has a team, single agenda otherwise.
    let professionalId: string | null = input.professionalId ?? null;
    if ((await activeProfessionals(tx, tenantId)).length) {
      if (!scope.all && !scope.professionalId) throw new AppError(403, 'not_linked', 'Your login is not linked to a team member');
      if (!input.allowOverlap) {
        professionalId = (await assignProfessional(tx, tenantId, svc.id, startsAt, endsAt, { professionalId: input.professionalId })).id;
      }
    } else if (
      !input.allowOverlap &&
      (await hasOverlap(tx, tenantId, startsAt, endsAt, { staffUserId: input.staffUserId ?? null }))
    ) {
      throw conflict('overlap', 'The time slot overlaps another appointment');
    }
    const [inserted] = await tx
      .insert(appointments)
      .values({ ...base, serviceId: svc.id, professionalId, startsAt, endsAt, priceCents: input.priceCents ?? svc.priceCents })
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
  if (!scope.all) {
    if (!inScope(scope, current)) throw notFound('appointment');
    // Team members can't hand a booking to someone else.
    if (input.professionalId !== undefined && input.professionalId !== current.professionalId) throw forbiddenScope();
    if (input.staffUserId !== undefined && input.staffUserId !== current.staffUserId) throw forbiddenScope();
    if (input.allowOverlap) input.allowOverlap = false;
  }
  const { kind } = await tenantKind(db, tenantId);
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
  if (input.professionalId) await assertProfessionalInTenant(db, tenantId, input.professionalId);
  const nextStatus = input.status ?? current.status;
  const reactivated = ACTIVE.has(nextStatus) && !ACTIVE.has(current.status);
  const restaurant = kind === 'reservations' && !isClass;
  const rental = !isClass && (kind === 'rentals' || Boolean(current.spaceId));
  const partySize = restaurant ? (input.partySize ?? current.partySize ?? 2) : (input.partySize ?? current.partySize);
  const tableChanged = input.tableId !== undefined && input.tableId !== current.tableId;
  const professionalId = input.professionalId === undefined ? current.professionalId : input.professionalId;
  const spaceId = input.spaceId === undefined ? current.spaceId : input.spaceId;
  const needsCheck =
    ACTIVE.has(nextStatus) &&
    !input.allowOverlap &&
    (timeChanged || staffUserId !== current.staffUserId || reactivated ||
      (restaurant && (tableChanged || partySize !== current.partySize)) ||
      (isClass && partySize !== current.partySize) ||
      professionalId !== current.professionalId ||
      spaceId !== current.spaceId);

  await db.transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    let tableId = input.tableId === undefined ? current.tableId : input.tableId;
    let nextProfessional = professionalId;
    let nextSpace = spaceId;
    let price = input.priceCents ?? current.priceCents;

    if (isClass) {
      if (needsCheck) {
        const { session, booked } = await lockSession(tx, tenantId, current.classSessionId!, id);
        assertRoom(session.capacity, booked, partySize ?? 1);
      }
    } else if (rental) {
      if (needsCheck) {
        const space = await assignSpace(tx, tenantId, startsAt, endsAt, { spaceId: spaceId ?? undefined, excludeId: id });
        nextSpace = space.id;
        // Re-price when the length or the space changes, unless a price was given.
        if (input.priceCents === undefined && (timeChanged || space.id !== current.spaceId)) {
          price = spacePriceCents(space.pricePerHourCents, duration);
        }
      }
    } else if (restaurant) {
      if (needsCheck) {
        if (input.tableId) {
          tableId = (await assignTable(tx, tenantId, partySize!, startsAt, endsAt, { excludeId: id, tableId: input.tableId })).id;
        } else {
          // Keep the current table if it still works, otherwise pick another one.
          try {
            tableId = current.tableId && input.tableId === undefined
              ? (await assignTable(tx, tenantId, partySize!, startsAt, endsAt, { excludeId: id, tableId: current.tableId })).id
              : (await assignTable(tx, tenantId, partySize!, startsAt, endsAt, { excludeId: id })).id;
          } catch {
            tableId = (await assignTable(tx, tenantId, partySize!, startsAt, endsAt, { excludeId: id })).id;
          }
        }
      }
    } else if ((await activeProfessionals(tx, tenantId)).length) {
      if (needsCheck) {
        nextProfessional = (await assignProfessional(tx, tenantId, current.serviceId, startsAt, endsAt, {
          professionalId,
          excludeId: id,
        })).id;
      }
    } else if (needsCheck && (await hasOverlap(tx, tenantId, startsAt, endsAt, { staffUserId, excludeId: id }))) {
      throw conflict('overlap', 'The time slot overlaps another appointment');
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
        tableId,
        professionalId: nextProfessional,
        spaceId: nextSpace,
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
  const [row] = await getDb()
    .delete(appointments)
    .where(
      and(eq(appointments.id, c.req.param('id')), eq(appointments.tenantId, c.get('tenantId'))),
    )
    .returning({ id: appointments.id });
  if (!row) throw notFound('appointment');
  return c.body(null, 204);
});
