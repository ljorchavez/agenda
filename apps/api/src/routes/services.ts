import { Hono } from 'hono';
import { and, asc, eq } from 'drizzle-orm';
import { serviceInputSchema } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { appointments, classSessions, services } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { toServiceDto } from '../lib/mappers.js';
import { requireBusinessManager, type AppEnv } from '../middleware/auth.js';

export const serviceRoutes = new Hono<AppEnv>();

serviceRoutes.get('/services', async (c) => {
  const rows = await getDb()
    .select()
    .from(services)
    .where(eq(services.tenantId, c.get('tenantId')))
    .orderBy(asc(services.name));
  return c.json(rows.map(toServiceDto));
});

serviceRoutes.post('/services', requireBusinessManager, async (c) => {
  const input = serviceInputSchema.parse(await c.req.json());
  const [row] = await getDb()
    .insert(services)
    .values({ ...input, tenantId: c.get('tenantId') })
    .returning();
  return c.json(toServiceDto(row!), 201);
});

serviceRoutes.put('/services/:id', requireBusinessManager, async (c) => {
  const input = serviceInputSchema.parse(await c.req.json());
  const [row] = await getDb()
    .update(services)
    .set(input)
    .where(and(eq(services.id, c.req.param('id')), eq(services.tenantId, c.get('tenantId'))))
    .returning();
  if (!row) throw notFound('service');
  return c.json(toServiceDto(row));
});

/** Services with appointment history are deactivated instead of deleted. */
serviceRoutes.delete('/services/:id', requireBusinessManager, async (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const tenantId = c.get('tenantId');
  const used =
    (await db.query.appointments.findFirst({
      where: and(eq(appointments.serviceId, id), eq(appointments.tenantId, tenantId)),
      columns: { id: true },
    })) ??
    // Class types with scheduled sessions are kept too.
    (await db.query.classSessions.findFirst({
      where: and(eq(classSessions.serviceId, id), eq(classSessions.tenantId, tenantId)),
      columns: { id: true },
    }));
  if (used) {
    const [row] = await db
      .update(services)
      .set({ active: false })
      .where(and(eq(services.id, id), eq(services.tenantId, tenantId)))
      .returning();
    if (!row) throw notFound('service');
    return c.json({ deactivated: true });
  }
  const [row] = await db
    .delete(services)
    .where(and(eq(services.id, id), eq(services.tenantId, tenantId)))
    .returning({ id: services.id });
  if (!row) throw notFound('service');
  return c.body(null, 204);
});
