import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { BUSINESS_TYPES, businessKind, type BusinessType, type DirectoryDto } from '@agenda/shared';
import { getDb } from '../db/client.js';

/**
 * Public directory of businesses that opted in (directory_listed = true) and set a location.
 * Exposes only public profile fields — never customers, appointments or owner data.
 */
export const directoryRoutes = new Hono();

directoryRoutes.get('/public-directory', async (c) => {
  const res = await getDb().execute<{
    slug: string;
    name: string;
    business_type: BusinessType;
    description: string | null;
    address: string | null;
    neighborhood: string | null;
    city: string | null;
    state: string | null;
    lat: number;
    lng: number;
    phone: string | null;
    online: boolean;
    price_from: number | string | null;
  }>(sql`
    select t.slug, t.name, t.business_type, t.description, t.address, t.neighborhood, t.city, t.state,
           t.lat, t.lng, t.phone,
           coalesce((t.settings->>'onlineBookingEnabled')::boolean, false) as online,
           (select min(s.price_cents) from services s
             where s.tenant_id = t.id and s.active and s.price_cents > 0) as price_from
    from tenants t
    where t.directory_listed and t.lat is not null and t.lng is not null and t.city is not null
    order by t.name
    limit 2000`);

  const entries = res.rows
    .filter((r) => (BUSINESS_TYPES as readonly string[]).includes(r.business_type))
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      businessType: r.business_type,
      kind: businessKind(r.business_type),
      description: r.description,
      address: r.address,
      neighborhood: r.neighborhood,
      city: r.city,
      state: r.state,
      lat: Number(r.lat),
      lng: Number(r.lng),
      phone: r.phone,
      onlineBooking: Boolean(r.online),
      priceFromCents: r.price_from == null ? null : Number(r.price_from),
    }));

  const byState = new Map<string, Set<string>>();
  for (const e of entries) {
    const st = e.state || '—';
    if (!byState.has(st)) byState.set(st, new Set());
    if (e.city) byState.get(st)!.add(e.city);
  }
  const body: DirectoryDto = {
    entries,
    zones: [...byState.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'es'))
      .map(([state, cities]) => ({ state, cities: [...cities].sort((a, b) => a.localeCompare(b, 'es')) })),
  };
  c.header('Cache-Control', 'public, max-age=60');
  return c.json(body);
});
