import { and, asc, desc, eq } from 'drizzle-orm';
import { PLAN_INCLUDED_LOCATIONS, type BusinessHours, type LocationDto, type PlanDto, type PublicLocationDto } from '@agenda/shared';
import type { Db } from '../db/client.js';
import { locations, type Location, type Tenant } from '../db/schema.js';
import { AppError } from './errors.js';
import type { Context } from 'hono';
import type { AppEnv } from '../middleware/auth.js';

type Q = Pick<Db, 'select'>;

export function listLocations(db: Q, tenantId: string): Promise<Location[]> {
  return db
    .select()
    .from(locations)
    .where(eq(locations.tenantId, tenantId))
    .orderBy(desc(locations.isPrimary), asc(locations.name));
}

/**
 * The requested location of this business (must be active), or the primary one when omitted.
 * Throws 404 `location_not_found` for other businesses' or inactive locations.
 */
export async function resolveLocation(db: Q, tenantId: string, locationId?: string | null): Promise<Location> {
  const where = locationId
    ? and(eq(locations.tenantId, tenantId), eq(locations.id, locationId), eq(locations.active, true))
    : and(eq(locations.tenantId, tenantId), eq(locations.isPrimary, true));
  const [loc] = await db.select().from(locations).where(where).limit(1);
  if (!loc) throw new AppError(404, 'location_not_found', 'Location not found or inactive');
  return loc;
}

/** Opening hours that apply to a location. */
export const hoursFor = (tenant: Pick<Tenant, 'settings'>, loc: Pick<Location, 'hours'> | null | undefined): BusinessHours =>
  loc?.hours ?? tenant.settings.hours;

export const toLocationDto = (l: Location): LocationDto => ({
  id: l.id,
  name: l.name,
  isPrimary: l.isPrimary,
  phone: l.phone,
  address: l.address,
  neighborhood: l.neighborhood,
  city: l.city,
  state: l.state,
  lat: l.lat,
  lng: l.lng,
  hours: l.hours ?? null,
  active: l.active,
});

/** Address/hours resolved for customers: the primary location falls back to the business profile. */
export function toPublicLocation(tenant: Tenant, l: Location): PublicLocationDto {
  const own = l.lat != null || l.address != null;
  const src = own || !l.isPrimary ? l : tenant;
  return {
    id: l.id,
    name: l.name,
    phone: l.phone ?? tenant.phone,
    address: src.address,
    neighborhood: src.neighborhood,
    city: src.city,
    state: src.state,
    lat: src.lat,
    lng: src.lng,
    hours: hoursFor(tenant, l),
  };
}

export function planFor(list: Pick<Location, 'active'>[]): PlanDto {
  const activeLocations = list.filter((l) => l.active).length;
  return {
    includedLocations: PLAN_INCLUDED_LOCATIONS,
    activeLocations,
    extraLocations: Math.max(0, activeLocations - PLAN_INCLUDED_LOCATIONS),
  };
}


/**
 * Location for creating/updating a resource or booking.
 * Logins limited to a location (gerentes, hosts) always work in it; others may pick any active
 * location of the business (default: primary on create, unchanged on update).
 */
export async function locationForWrite(
  db: Q,
  c: Context<AppEnv>,
  requested: string | null | undefined,
  opts: { current?: string; create?: boolean } = {},
): Promise<string | undefined> {
  const own = c.get('role') === 'owner' ? null : c.get('locationId');
  if (own) {
    if ((requested && requested !== own) || (opts.current && opts.current !== own)) {
      throw new AppError(403, 'not_your_location', 'You can only manage your location');
    }
    return own;
  }
  if (requested) return (await resolveLocation(db, c.get('tenantId'), requested)).id;
  return opts.create ? (await resolveLocation(db, c.get('tenantId'))).id : undefined;
}

/** Gerentes de sucursal can only touch their location's rows. */
export function guardRow(c: Context<AppEnv>, rowLocationId: string) {
  const own = c.get('role') === 'owner' ? null : c.get('locationId');
  if (own && own !== rowLocationId) throw new AppError(403, 'not_your_location', 'You can only manage your location');
}
