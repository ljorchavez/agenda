import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { BUSINESS_TYPES, businessKind, MIN_PUBLIC_REVIEWS, type BusinessType, type DirectoryDto } from '@agenda/shared';
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
    hourly_from: number | string | null;
    service_from: number | string | null;
    rating_avg: number | string | null;
    rating_count: number | string | null;
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
           -- Hourly-priced resources (courts, rooms) show "desde $X/hora"; otherwise the cheapest service.
           (select min(r.price_per_hour_cents) from resources r
             where r.tenant_id = t.id and r.active and r.price_per_hour_cents > 0) as hourly_from,
           (select min(s.price_cents) from services s
             where s.tenant_id = t.id and s.active and s.price_cents > 0) as service_from,
           -- Shown only when the business keeps reviews public and has at least MIN_PUBLIC_REVIEWS
           case when coalesce(t.settings->'reviews'->>'public', 'true') <> 'false'
             then (select avg(rv.rating) from reviews rv where rv.tenant_id = t.id and not rv.hidden) end as rating_avg,
           case when coalesce(t.settings->'reviews'->>'public', 'true') <> 'false'
             then (select count(*) from reviews rv where rv.tenant_id = t.id and not rv.hidden) else 0 end as rating_count
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
      priceFromCents: r.hourly_from != null ? Number(r.hourly_from) : r.service_from == null ? null : Number(r.service_from),
      priceUnit: r.hourly_from != null ? ('hour' as const) : null,
      locationId: r.location_id,
      locationName: Number(r.location_count) > 1 ? r.location_name : null,
      ratingAverage: r.rating_avg == null || Number(r.rating_count ?? 0) < MIN_PUBLIC_REVIEWS ? null : Math.round(Number(r.rating_avg) * 10) / 10,
      ratingCount: Number(r.rating_count ?? 0) < MIN_PUBLIC_REVIEWS ? 0 : Number(r.rating_count ?? 0),
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
