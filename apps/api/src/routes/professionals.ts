import { Hono } from 'hono';
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { professionalInputSchema } from '@agenda/shared';
import { getDb, type Db } from '../db/client.js';
import { appointments, professionals, services, users } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { toProfessionalDto } from '../lib/mappers.js';
import { requireOwner, type AppEnv } from '../middleware/auth.js';

/**
 * Team members who attend appointments (barbers, doctors, therapists, instructors).
 * With at least one active professional, each person has their own agenda.
 */
export const professionalRoutes = new Hono<AppEnv>();

/** Referenced services and login must belong to the same tenant. */
async function validateRefs(db: Db, tenantId: string, serviceIds: string[], userId: string | null | undefined) {
  if (serviceIds.length) {
    const found = await db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.tenantId, tenantId), inArray(services.id, serviceIds)));
    if (found.length !== new Set(serviceIds).size) throw notFound('service');
  }
  if (userId) {
    const u = await db.query.users.findFirst({ where: and(eq(users.id, userId), eq(users.tenantId, tenantId)), columns: { id: true } });
    if (!u) throw notFound('user');
  }
}

professionalRoutes.get('/professionals', async (c) => {
  const rows = await getDb()
    .select()
    .from(professionals)
    .where(eq(professionals.tenantId, c.get('tenantId')))
    .orderBy(asc(professionals.name));
  return c.json(rows.map(toProfessionalDto));
});

professionalRoutes.post('/professionals', requireOwner, async (c) => {
  const input = professionalInputSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  const db = getDb();
  await validateRefs(db, tenantId, input.serviceIds, input.userId);
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from tenants where id = ${tenantId} for update`);
    const before = await tx
      .select({ id: professionals.id })
      .from(professionals)
      .where(and(eq(professionals.tenantId, tenantId), eq(professionals.active, true)))
      .limit(1);
    const [created] = await tx
      .insert(professionals)
      .values({ ...input, serviceIds: [...new Set(input.serviceIds)], userId: input.userId ?? null, tenantId })
      .returning();
    // Switching from a single agenda to a team: upcoming appointments go to the first professional.
    if (!before.length && created!.active) {
      await tx
        .update(appointments)
        .set({ professionalId: created!.id })
        .where(
          and(
            eq(appointments.tenantId, tenantId),
            isNull(appointments.professionalId),
            isNull(appointments.classSessionId),
            isNull(appointments.spaceId),
            isNull(appointments.tableId),
            gte(appointments.startsAt, new Date()),
          ),
        );
    }
    return created!;
  });
  return c.json(toProfessionalDto(row), 201);
});

professionalRoutes.put('/professionals/:id', requireOwner, async (c) => {
  const input = professionalInputSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  const db = getDb();
  await validateRefs(db, tenantId, input.serviceIds, input.userId);
  const [row] = await db
    .update(professionals)
    .set({ ...input, serviceIds: [...new Set(input.serviceIds)], userId: input.userId ?? null })
    .where(and(eq(professionals.id, c.req.param('id')), eq(professionals.tenantId, tenantId)))
    .returning();
  if (!row) throw notFound('professional');
  return c.json(toProfessionalDto(row));
});

/** Deletes a professional; with booking history it is deactivated instead so reports keep their name. */
professionalRoutes.delete('/professionals/:id', requireOwner, async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const db = getDb();
  const used = await db.query.appointments.findFirst({
    where: and(eq(appointments.tenantId, tenantId), eq(appointments.professionalId, id)),
    columns: { id: true },
  });
  if (used) {
    const [row] = await db
      .update(professionals)
      .set({ active: false })
      .where(and(eq(professionals.id, id), eq(professionals.tenantId, tenantId)))
      .returning();
    if (!row) throw notFound('professional');
    return c.json({ deactivated: true });
  }
  const [row] = await db
    .delete(professionals)
    .where(and(eq(professionals.id, id), eq(professionals.tenantId, tenantId)))
    .returning({ id: professionals.id });
  if (!row) throw notFound('professional');
  return c.body(null, 204);
});
