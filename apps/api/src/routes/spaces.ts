import { Hono } from 'hono';
import { and, asc, eq, sql } from 'drizzle-orm';
import { spaceInputSchema } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { spaces } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { toSpaceDto } from '../lib/mappers.js';
import { requireOwner, type AppEnv } from '../middleware/auth.js';

/** Spaces rented by the hour (courts, rooms, studios), scoped by tenant. Only owners can change them. */
export const spaceRoutes = new Hono<AppEnv>();

spaceRoutes.get('/spaces', async (c) => {
  const rows = await getDb()
    .select()
    .from(spaces)
    .where(eq(spaces.tenantId, c.get('tenantId')))
    .orderBy(asc(spaces.name));
  rows.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
  return c.json(rows.map(toSpaceDto));
});

spaceRoutes.post('/spaces', requireOwner, async (c) => {
  const input = spaceInputSchema.parse(await c.req.json());
  const [row] = await getDb()
    .insert(spaces)
    .values({ ...input, description: input.description ?? null, tenantId: c.get('tenantId') })
    .returning();
  return c.json(toSpaceDto(row!), 201);
});

spaceRoutes.put('/spaces/:id', requireOwner, async (c) => {
  const input = spaceInputSchema.parse(await c.req.json());
  const [row] = await getDb()
    .update(spaces)
    .set({ ...input, description: input.description ?? null })
    .where(and(eq(spaces.id, c.req.param('id')), eq(spaces.tenantId, c.get('tenantId'))))
    .returning();
  if (!row) throw notFound('space');
  return c.json(toSpaceDto(row));
});

/** Spaces with booking history are deactivated instead of deleted. */
spaceRoutes.delete('/spaces/:id', requireOwner, async (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const tenantId = c.get('tenantId');
  const used = await db.execute(sql`select 1 from appointments where tenant_id = ${tenantId} and space_id = ${id} limit 1`);
  if (used.rows.length) {
    const [row] = await db
      .update(spaces)
      .set({ active: false })
      .where(and(eq(spaces.id, id), eq(spaces.tenantId, tenantId)))
      .returning();
    if (!row) throw notFound('space');
    return c.json({ deactivated: true, space: toSpaceDto(row) });
  }
  const [row] = await db
    .delete(spaces)
    .where(and(eq(spaces.id, id), eq(spaces.tenantId, tenantId)))
    .returning({ id: spaces.id });
  if (!row) throw notFound('space');
  return c.body(null, 204);
});
