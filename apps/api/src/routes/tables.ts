import { Hono } from 'hono';
import { and, asc, eq, sql } from 'drizzle-orm';
import { tableInputSchema, type TableDto } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { diningTables, type DiningTable } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { guardRow, locationForWrite } from '../lib/locations.js';
import { requireManager, type AppEnv } from '../middleware/auth.js';

/** Restaurant tables, scoped by tenant. Only owners can change them. */
export const tableRoutes = new Hono<AppEnv>();

const toDto = (t: DiningTable): TableDto => ({ id: t.id, name: t.name, seats: t.seats, area: t.area, active: t.active, locationId: t.locationId });

tableRoutes.get('/tables', async (c) => {
  const rows = await getDb()
    .select()
    .from(diningTables)
    .where(eq(diningTables.tenantId, c.get('tenantId')))
    .orderBy(asc(diningTables.name));
  rows.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
  return c.json(rows.map(toDto));
});

tableRoutes.post('/tables', requireManager, async (c) => {
  const input = tableInputSchema.parse(await c.req.json());
  const db = getDb();
  const locationId = await locationForWrite(db, c, input.locationId, { create: true });
  const [row] = await db
    .insert(diningTables)
    .values({ ...input, area: input.area ?? null, tenantId: c.get('tenantId'), locationId })
    .returning();
  return c.json(toDto(row!), 201);
});

tableRoutes.put('/tables/:id', requireManager, async (c) => {
  const input = tableInputSchema.parse(await c.req.json());
  const db = getDb();
  const current = await db.query.diningTables.findFirst({
    where: and(eq(diningTables.id, c.req.param('id')), eq(diningTables.tenantId, c.get('tenantId'))),
  });
  if (!current) throw notFound('table');
  const locationId = await locationForWrite(db, c, input.locationId, { current: current.locationId });
  const [row] = await db
    .update(diningTables)
    .set({ ...input, area: input.area ?? null, locationId })
    .where(and(eq(diningTables.id, c.req.param('id')), eq(diningTables.tenantId, c.get('tenantId'))))
    .returning();
  if (!row) throw notFound('table');
  return c.json(toDto(row));
});

/** Tables with upcoming reservations are deactivated instead of deleted. */
tableRoutes.delete('/tables/:id', requireManager, async (c) => {
  const db = getDb();
  const id = c.req.param('id');
  const tenantId = c.get('tenantId');
  const current = await db.query.diningTables.findFirst({ where: and(eq(diningTables.id, id), eq(diningTables.tenantId, tenantId)) });
  if (!current) throw notFound('table');
  guardRow(c, current.locationId);
  const used = await db.execute(sql`
    select 1 from appointments where tenant_id = ${tenantId} and table_id = ${id}
      and status in ('scheduled', 'confirmed') and starts_at > now() limit 1`);
  if (used.rows.length) {
    const [row] = await db
      .update(diningTables)
      .set({ active: false })
      .where(and(eq(diningTables.id, id), eq(diningTables.tenantId, tenantId)))
      .returning();
    if (!row) throw notFound('table');
    return c.json({ deactivated: true, table: toDto(row) });
  }
  const [row] = await db
    .delete(diningTables)
    .where(and(eq(diningTables.id, id), eq(diningTables.tenantId, tenantId)))
    .returning({ id: diningTables.id });
  if (!row) throw notFound('table');
  return c.body(null, 204);
});
