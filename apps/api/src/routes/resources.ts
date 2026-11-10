import { Hono } from 'hono';
import { and, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import { resourceInputSchema, type ResourceInput } from '@agenda/shared';
import { getDb, type Db } from '../db/client.js';
import { appointments, memberships, resources, services } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { guardRow, locationForWrite } from '../lib/locations.js';
import { toResourceDto } from '../lib/mappers.js';
import { requireManager, type AppEnv } from '../middleware/auth.js';

/**
 * Resources: whatever gets booked (team members, instructors, courts, rooms, tables).
 * Same fields and rules for every kind of business.
 */
export const resourceRoutes = new Hono<AppEnv>();

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'es', { numeric: true });

/** Referenced services and login must belong to the same tenant. */
async function validateRefs(db: Db, tenantId: string, input: ResourceInput) {
  if (input.serviceIds.length) {
    const found = await db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.tenantId, tenantId), inArray(services.id, input.serviceIds)));
    if (found.length !== new Set(input.serviceIds).size) throw notFound('service');
  }
  if (input.userId) {
    const m = await db.query.memberships.findFirst({ where: and(eq(memberships.userId, input.userId), eq(memberships.tenantId, tenantId)), columns: { id: true } });
    if (!m) throw notFound('user');
  }
}

const values = (input: ResourceInput) => ({
  name: input.name,
  color: input.color,
  active: input.active,
  serviceIds: [...new Set(input.serviceIds)],
  userId: input.userId ?? null,
  capacity: input.capacity ?? null,
  pricePerHourCents: input.pricePerHourCents ?? null,
  description: input.description ?? null,
  // Left out of the request = keep what's saved
  ...(input.hours !== undefined ? { hours: input.hours } : {}),
  ...(input.photoUrl !== undefined ? { photoUrl: input.photoUrl } : {}),
});

resourceRoutes.get('/resources', async (c) => {
  const rows = await getDb().select().from(resources).where(eq(resources.tenantId, c.get('tenantId')));
  return c.json(rows.sort(byName).map(toResourceDto));
});

resourceRoutes.post('/resources', requireManager, async (c) => {
  const input = resourceInputSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  const db = getDb();
  await validateRefs(db, tenantId, input);
  const locationId = (await locationForWrite(db, c, input.locationId, { create: true }))!;
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select id from tenants where id = ${tenantId} for update`);
    const before = await tx
      .select({ id: resources.id })
      .from(resources)
      .where(and(eq(resources.tenantId, tenantId), eq(resources.locationId, locationId), eq(resources.active, true)))
      .limit(1);
    // A login belongs to one resource at most.
    if (input.userId) await tx.update(resources).set({ userId: null }).where(and(eq(resources.tenantId, tenantId), eq(resources.userId, input.userId)));
    const [created] = await tx.insert(resources).values({ ...values(input), tenantId, locationId }).returning();
    // A location that worked as a single agenda: its upcoming bookings go to the first resource.
    if (!before.length && created!.active) {
      await tx
        .update(appointments)
        .set({ resourceId: created!.id })
        .where(
          and(
            eq(appointments.tenantId, tenantId),
            eq(appointments.locationId, locationId),
            isNull(appointments.resourceId),
            isNull(appointments.classSessionId),
            gte(appointments.startsAt, new Date()),
          ),
        );
    }
    return created!;
  });
  return c.json(toResourceDto(row), 201);
});

resourceRoutes.put('/resources/:id', requireManager, async (c) => {
  const input = resourceInputSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const db = getDb();
  await validateRefs(db, tenantId, input);
  const current = await db.query.resources.findFirst({ where: and(eq(resources.id, id), eq(resources.tenantId, tenantId)) });
  if (!current) throw notFound('resource');
  const locationId = await locationForWrite(db, c, input.locationId, { current: current.locationId });
  if (input.userId) {
    await db.update(resources).set({ userId: null }).where(and(eq(resources.tenantId, tenantId), eq(resources.userId, input.userId), ne(resources.id, id)));
  }
  const [row] = await db
    .update(resources)
    .set({ ...values(input), locationId })
    .where(and(eq(resources.id, id), eq(resources.tenantId, tenantId)))
    .returning();
  if (!row) throw notFound('resource');
  return c.json(toResourceDto(row));
});

/** With booking history it is deactivated instead, so the calendar and reports keep its name. */
resourceRoutes.delete('/resources/:id', requireManager, async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const db = getDb();
  const current = await db.query.resources.findFirst({ where: and(eq(resources.id, id), eq(resources.tenantId, tenantId)) });
  if (!current) throw notFound('resource');
  guardRow(c, current.locationId);
  const used = await db.execute(sql`
    select 1 from appointments where tenant_id = ${tenantId} and resource_id = ${id}
    union all select 1 from class_sessions where tenant_id = ${tenantId} and resource_id = ${id}
    limit 1`);
  if (used.rows.length) {
    const [row] = await db.update(resources).set({ active: false }).where(and(eq(resources.id, id), eq(resources.tenantId, tenantId))).returning();
    return c.json({ deactivated: true, resource: toResourceDto(row!) });
  }
  await db.delete(resources).where(and(eq(resources.id, id), eq(resources.tenantId, tenantId)));
  return c.body(null, 204);
});
