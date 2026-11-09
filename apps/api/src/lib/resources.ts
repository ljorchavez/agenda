import { and, asc, eq, sql } from 'drizzle-orm';
import { eligibleResources, RESOURCE_COLORS, reservationSettingsOf, type BusinessKind } from '@agenda/shared';
import type { Db } from '../db/client.js';
import { resources, services, type Resource, type Service, type Tenant } from '../db/schema.js';
import { AppError } from './errors.js';

/**
 * Booking engine shared by every kind of business. A resource is whatever gets booked (a person,
 * a court, a table). A booking needs one that is active in the location, takes the service, fits
 * the party and is free at that time.
 */

type Q = Pick<Db, 'select' | 'execute'>;
export type Interval = { s: Date; e: Date };
/** Busy time of one resource (`rid`), or of the location when the booking has no resource (`rid` null). */
export type Busy = Interval & { rid: string | null };
export type ResourceLite = Pick<Resource, 'id' | 'name' | 'serviceIds' | 'capacity'>;
export type Need = { serviceId?: string | null; partySize?: number | null };

const overlaps = (b: Interval, start: Date, end: Date) => b.s < end && b.e > start;
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, 'es', { numeric: true });

/** Active resources of a location (none = that location works as a single agenda). */
export async function activeResources(db: Pick<Db, 'select'>, tenantId: string, locationId?: string): Promise<Resource[]> {
  const rows = await db
    .select()
    .from(resources)
    .where(and(eq(resources.tenantId, tenantId), eq(resources.active, true), locationId ? eq(resources.locationId, locationId) : undefined))
    .orderBy(asc(resources.name));
  return rows.sort(byName);
}

/**
 * Best free resource for [start, end), or null. Pure, so it can be unit-tested.
 * Order: smallest capacity that fits (best table for the party), then the least busy (spreads the
 * work), then by name. Bookings without a resource use up one resource each.
 */
export function pickResource<T extends ResourceLite>(list: T[], busy: Busy[], start: Date, end: Date): T | null {
  const free = list.filter((r) => !busy.some((b) => b.rid === r.id && overlaps(b, start, end)));
  const unassigned = busy.filter((b) => b.rid === null && overlaps(b, start, end)).length;
  if (free.length <= unassigned) return null;
  const load = (id: string) => busy.filter((b) => b.rid === id).length;
  const cap = (r: T) => r.capacity ?? Number.MAX_SAFE_INTEGER;
  return [...free].sort((a, b) => cap(a) - cap(b) || load(a.id) - load(b.id) || byName(a, b))[0]!;
}

/**
 * Busy intervals in [from, to): bookings (class sign-ups excluded, the class itself counts) and
 * the classes each resource runs. Unassigned bookings only count in their own location.
 */
export async function resourceBusy(
  db: Pick<Db, 'execute'>,
  tenantId: string,
  from: Date,
  to: Date,
  opts: { excludeId?: string; locationId?: string } = {},
): Promise<Busy[]> {
  const exclude = opts.excludeId ? sql`and id <> ${opts.excludeId}` : sql``;
  const loc = opts.locationId ? sql`and (resource_id is not null or location_id = ${opts.locationId})` : sql``;
  const res = await db.execute<{ rid: string | null; s: Date | string; e: Date | string }>(sql`
    select resource_id as rid, starts_at as s, ends_at as e from appointments
    where tenant_id = ${tenantId} and status in ('scheduled', 'confirmed') and class_session_id is null
      and starts_at < ${to.toISOString()} and ends_at > ${from.toISOString()} ${exclude} ${loc}
    union all
    select resource_id as rid, starts_at as s, ends_at as e from class_sessions
    where tenant_id = ${tenantId} and status = 'scheduled' and resource_id is not null
      and starts_at < ${to.toISOString()} and ends_at > ${from.toISOString()}`);
  return res.rows.map((r) => ({ rid: r.rid, s: new Date(r.s), e: new Date(r.e) }));
}

/**
 * Picks (or validates) the resource for a booking. Call inside the tenant lock.
 * 404 unknown resource · 422 doesn't take the service / too small · 409 busy or nothing free.
 */
export async function assignResource(
  db: Q,
  tenantId: string,
  start: Date,
  end: Date,
  opts: Need & { resourceId?: string | null; excludeId?: string; locationId?: string } = {},
): Promise<Resource> {
  const list = await activeResources(db, tenantId, opts.locationId);
  // A ±12 h window also gives a rough per-day load for spreading bookings.
  const busy = await resourceBusy(db, tenantId, new Date(start.getTime() - 12 * 3600e3), new Date(end.getTime() + 12 * 3600e3), opts);
  if (opts.resourceId) {
    const r = list.find((x) => x.id === opts.resourceId);
    if (!r) throw new AppError(404, 'resource_not_found', 'Not found or inactive');
    if (!eligibleResources([r], { serviceId: opts.serviceId }).length) throw new AppError(422, 'resource_service', 'It does not take this service');
    if (!eligibleResources([r], { partySize: opts.partySize }).length) throw new AppError(422, 'resource_too_small', 'Too small for the party');
    if (!pickResource([r], busy, start, end)) throw new AppError(409, 'resource_busy', 'Busy at that time');
    return r;
  }
  const chosen = pickResource(eligibleResources(list, opts), busy, start, end);
  if (!chosen) throw new AppError(409, 'no_resource_available', 'Nothing available at that time');
  return chosen;
}

/** Resource of the tenant by id (any status), or 404. */
export async function findResource(db: Pick<Db, 'query'>, tenantId: string, id: string): Promise<Resource> {
  const r = await db.query.resources.findFirst({ where: and(eq(resources.id, id), eq(resources.tenantId, tenantId)) });
  if (!r) throw new AppError(404, 'resource_not_found', 'Not found');
  return r;
}

// ---------- Internal service ----------

/**
 * Kinds that book without choosing a service (party size, duration) use one internal service;
 * it is created on demand.
 */
export async function defaultService(db: Pick<Db, 'select' | 'insert'>, tenant: Tenant, kind: BusinessKind): Promise<Service> {
  const [svc] = await db
    .select()
    .from(services)
    .where(and(eq(services.tenantId, tenant.id), eq(services.active, true)))
    .orderBy(asc(services.createdAt))
    .limit(1);
  if (svc) return svc;
  const [created] = await db
    .insert(services)
    .values(
      kind === 'reservations'
        ? { tenantId: tenant.id, name: 'Reservación', durationMin: reservationSettingsOf(tenant.settings).durationMin, priceCents: 0 }
        : { tenantId: tenant.id, name: 'Renta de espacio', durationMin: 60, priceCents: 0 },
    )
    .returning();
  return created!;
}

/** Starter resources for a new business so online booking works right away. */
export function starterResources(kind: BusinessKind, type: string): { name: string; color: string; capacity?: number; pricePerHourCents?: number }[] {
  if (kind === 'reservations') {
    return [2, 2, 4, 4, 6].map((capacity, i) => ({ name: `Mesa ${i + 1}`, color: RESOURCE_COLORS[i % RESOURCE_COLORS.length]!, capacity }));
  }
  if (kind === 'rentals') {
    if (type === 'sports') return [{ name: 'Cancha 1', color: '#2563eb', pricePerHourCents: 0 }, { name: 'Cancha 2', color: '#16a34a', pricePerHourCents: 0 }];
    if (type === 'coworking') return [{ name: 'Sala de juntas', color: '#2563eb', pricePerHourCents: 0 }];
    return [{ name: 'Estudio A', color: '#2563eb', pricePerHourCents: 0 }];
  }
  return [];
}
