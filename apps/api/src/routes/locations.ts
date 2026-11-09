import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { locationInputSchema, normalizeMxPhone } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { locations } from '../db/schema.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { listLocations, planFor, toLocationDto } from '../lib/locations.js';
import { assertCanAddLocation } from '../lib/plan.js';
import { requireBusinessManager, type AppEnv } from '../middleware/auth.js';

/**
 * Locations (sucursales) of a business. Customers, services and payouts are shared;
 * team, tables, spaces, classes, hours and bookings belong to a location.
 * Billing (docs/billing.md): the plan includes one location; extra active ones are an add-on.
 */
export const locationRoutes = new Hono<AppEnv>();

locationRoutes.get('/locations', async (c) => {
  const list = await listLocations(getDb(), c.get('tenantId'));
  return c.json({ locations: list.map(toLocationDto), plan: planFor(list) });
});

const clean = (input: ReturnType<typeof locationInputSchema.parse>) => ({
  name: input.name,
  phone: input.phone ? normalizeMxPhone(input.phone) : null,
  address: input.address ?? null,
  neighborhood: input.neighborhood ?? null,
  city: input.city ?? null,
  state: input.state ?? null,
  lat: input.lat ?? null,
  lng: input.lng ?? null,
  hours: input.hours ?? null,
  active: input.active,
});

locationRoutes.post('/locations', requireBusinessManager, async (c) => {
  const input = locationInputSchema.parse(await c.req.json());
  const db = getDb();
  if (input.active) await assertCanAddLocation(db, c.get('tenantId'));
  const [row] = await db
    .insert(locations)
    .values({ ...clean(input), tenantId: c.get('tenantId'), isPrimary: false })
    .returning();
  const list = await listLocations(db, c.get('tenantId'));
  return c.json({ location: toLocationDto(row!), plan: planFor(list) }, 201);
});

locationRoutes.put('/locations/:id', requireBusinessManager, async (c) => {
  const input = locationInputSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const db = getDb();
  const current = await db.query.locations.findFirst({ where: and(eq(locations.id, id), eq(locations.tenantId, tenantId)) });
  if (!current) throw notFound('location');
  if (!current.active && input.active) await assertCanAddLocation(db, tenantId);
  if (current.isPrimary && !input.active) throw new AppError(422, 'primary_location', 'The main location cannot be deactivated');
  if (current.active && !input.active) {
    const upcoming = await db.execute(sql`
      select 1 from appointments where tenant_id = ${tenantId} and location_id = ${id}
        and status in ('scheduled', 'confirmed') and starts_at > now() limit 1`);
    if (upcoming.rows.length) throw conflict('location_has_bookings', 'Move or cancel its upcoming bookings first');
  }
  const [row] = await db.update(locations).set(clean(input)).where(eq(locations.id, id)).returning();
  const list = await listLocations(db, tenantId);
  return c.json({ location: toLocationDto(row!), plan: planFor(list) });
});
