import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import {
  appointmentCreateSchema,
  appointmentListQuerySchema,
  appointmentUpdateSchema,
  businessKind,
} from '@agenda/shared';
import { getDb } from '../db/client.js';
import { appointments, customers, payments, services, tenants, users } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { hasOverlap, queryAppointments } from '../lib/appointments.js';
import { assignTable } from '../lib/tables.js';
import { conflict, notFound } from '../lib/errors.js';
import type { AppEnv } from '../middleware/auth.js';

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

/** Restaurants assign tables per reservation instead of blocking the whole business. */
async function isRestaurant(db: Db, tenantId: string): Promise<boolean> {
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId), columns: { businessType: true } });
  return t ? businessKind(t.businessType) === 'reservations' : false;
}

/** Serializes writes per tenant so two requests can't take the same slot. */
const lockTenant = (tx: Pick<Db, 'execute'>, tenantId: string) =>
  tx.execute(sql`select id from tenants where id = ${tenantId} for update`);

appointmentRoutes.get('/appointments', async (c) => {
  const { from, to } = appointmentListQuerySchema.parse(c.req.query());
  const rows = await queryAppointments(
    getDb(),
    c.get('tenantId'),
    sql`a.starts_at >= ${from} and a.starts_at < ${to}`,
  );
  return c.json(rows);
});

appointmentRoutes.get('/appointments/:id', async (c) => {
  const [row] = await queryAppointments(
    getDb(),
    c.get('tenantId'),
    sql`a.id = ${c.req.param('id')}`,
  );
  if (!row) throw notFound('appointment');
  return c.json(row);
});

appointmentRoutes.post('/appointments', async (c) => {
  const input = appointmentCreateSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  const db = getDb();

  // Both referenced rows must belong to the caller's tenant.
  const [customer, service] = await Promise.all([
    db.query.customers.findFirst({
      where: and(eq(customers.id, input.customerId), eq(customers.tenantId, tenantId)),
    }),
    db.query.services.findFirst({
      where: and(eq(services.id, input.serviceId), eq(services.tenantId, tenantId)),
    }),
  ]);
  if (!customer) throw notFound('customer');
  if (!service) throw notFound('service');
  await assertStaffInTenant(db, tenantId, input.staffUserId);

  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(startsAt.getTime() + (input.durationMin ?? service.durationMin) * MIN);
  const restaurant = await isRestaurant(db, tenantId);
  const partySize = restaurant ? (input.partySize ?? 2) : null;

  const row = await db.transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    let tableId: string | null = null;
    if (restaurant) {
      // Explicit table is always validated; otherwise auto-assign unless overlap is allowed.
      if (input.tableId || !input.allowOverlap) {
        tableId = (await assignTable(tx, tenantId, partySize!, startsAt, endsAt, { tableId: input.tableId })).id;
      }
    } else if (
      !input.allowOverlap &&
      (await hasOverlap(tx, tenantId, startsAt, endsAt, { staffUserId: input.staffUserId ?? null }))
    ) {
      throw conflict('overlap', 'The time slot overlaps another appointment');
    }
    const [inserted] = await tx
      .insert(appointments)
      .values({
        tenantId,
        customerId: customer.id,
        serviceId: service.id,
        staffUserId: input.staffUserId ?? null,
        startsAt,
        endsAt,
        priceCents: input.priceCents ?? service.priceCents,
        notes: input.notes ?? null,
        source: 'staff',
        partySize,
        tableId,
      })
      .returning({ id: appointments.id });
    return inserted;
  });

  const [dto] = await queryAppointments(db, tenantId, sql`a.id = ${row!.id}`);
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

  const startsAt = input.startsAt ? new Date(input.startsAt) : current.startsAt;
  const duration =
    input.durationMin ?? (current.endsAt.getTime() - current.startsAt.getTime()) / MIN;
  const endsAt = new Date(startsAt.getTime() + duration * MIN);
  const timeChanged =
    startsAt.getTime() !== current.startsAt.getTime() ||
    endsAt.getTime() !== current.endsAt.getTime();
  const staffUserId =
    input.staffUserId === undefined ? current.staffUserId : input.staffUserId;
  if (input.staffUserId !== undefined) await assertStaffInTenant(db, tenantId, staffUserId);
  const nextStatus = input.status ?? current.status;
  const reactivated = ACTIVE.has(nextStatus) && !ACTIVE.has(current.status);
  const restaurant = await isRestaurant(db, tenantId);
  const partySize = restaurant ? (input.partySize ?? current.partySize ?? 2) : current.partySize;
  const tableChanged = input.tableId !== undefined && input.tableId !== current.tableId;
  const needsOverlapCheck =
    ACTIVE.has(nextStatus) &&
    !input.allowOverlap &&
    (timeChanged || staffUserId !== current.staffUserId || reactivated ||
      (restaurant && (tableChanged || partySize !== current.partySize)));

  await db.transaction(async (tx) => {
    await lockTenant(tx, tenantId);
    let tableId = input.tableId === undefined ? current.tableId : input.tableId;
    if (restaurant && needsOverlapCheck) {
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
    } else if (
      !restaurant &&
      needsOverlapCheck &&
      (await hasOverlap(tx, tenantId, startsAt, endsAt, { staffUserId, excludeId: id }))
    ) {
      throw conflict('overlap', 'The time slot overlaps another appointment');
    }
    await tx
      .update(appointments)
      .set({
        startsAt,
        endsAt,
        staffUserId,
        status: nextStatus,
        priceCents: input.priceCents ?? current.priceCents,
        notes: input.notes === undefined ? current.notes : input.notes,
        partySize,
        tableId,
        // Rescheduling re-arms the reminder.
        reminderSentAt: timeChanged ? null : current.reminderSentAt,
      })
      .where(and(eq(appointments.id, id), eq(appointments.tenantId, tenantId)));

    if (input.status === 'completed' && input.paymentMethod) {
      const paid = await tx.execute<{ total: string | null }>(sql`
        select sum(amount_cents) as total from payments
        where appointment_id = ${id} and tenant_id = ${tenantId} and status = 'paid'`);
      const outstanding =
        (input.priceCents ?? current.priceCents) - Number(paid.rows[0]?.total ?? 0);
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

appointmentRoutes.delete('/appointments/:id', async (c) => {
  const [row] = await getDb()
    .delete(appointments)
    .where(
      and(eq(appointments.id, c.req.param('id')), eq(appointments.tenantId, c.get('tenantId'))),
    )
    .returning({ id: appointments.id });
  if (!row) throw notFound('appointment');
  return c.body(null, 204);
});
