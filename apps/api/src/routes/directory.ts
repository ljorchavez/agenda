import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { BUSINESS_TYPES, businessKind, type BusinessType, type DirectoryDto } from '@agenda/shared';
import { getDb } from '../db/client.js';

/**
 * Public directory of businesses that opted in (directory_listed = true): one pin per active location
 * (the primary location uses the business profile address unless it has its own).
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
    location_id: string;
    location_name: string;
    location_count: number | string;
  }>(sql`
    with pins as (
      select l.id as location_id, l.name as location_name, l.tenant_id,
             case when l.lat is null and l.is_primary then t.address else l.address end as address,
             case when l.lat is null and l.is_primary then t.neighborhood else l.neighborhood end as neighborhood,
             case when l.lat is null and l.is_primary then t.city else l.city end as city,
             case when l.lat is null and l.is_primary then t.state else l.state end as state,
             coalesce(l.lat, case when l.is_primary then t.lat end) as lat,
             coalesce(l.lng, case when l.is_primary then t.lng end) as lng,
             coalesce(l.phone, t.phone) as phone,
             count(*) over (partition by l.tenant_id) as location_count
      from locations l join tenants t on t.id = l.tenant_id
      where l.active and t.directory_listed
    )
    select t.slug, t.name, t.business_type, t.description, p.address, p.neighborhood, p.city, p.state,
           p.lat, p.lng, p.phone, p.location_id, p.location_name, p.location_count,
           coalesce((t.settings->>'onlineBookingEnabled')::boolean, false) as online,
           case when t.business_type in ('sports', 'coworking', 'studio')
             then (select min(sp.price_per_hour_cents) from spaces sp
                   where sp.tenant_id = t.id and sp.active and sp.price_per_hour_cents > 0)
             else (select min(s.price_cents) from services s
                   where s.tenant_id = t.id and s.active and s.price_cents > 0) end as price_from
    from pins p join tenants t on t.id = p.tenant_id
    where p.lat is not null and p.lng is not null and p.city is not null
    order by t.name, p.location_name
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
      priceUnit: businessKind(r.business_type) === 'rentals' && r.price_from != null ? ('hour' as const) : null,
      locationId: r.location_id,
      locationName: Number(r.location_count) > 1 ? r.location_name : null,
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
