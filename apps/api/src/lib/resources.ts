import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { professionals, services, spaces, type Professional, type Service, type Space, type Tenant } from '../db/schema.js';
import { AppError } from './errors.js';

type Q = Pick<Db, 'select' | 'execute'>;
export type Interval = { s: Date; e: Date };
export type ProBusy = Interval & { pid: string | null };
export type SpaceBusy = Interval & { sid: string };
export type ProLite = Pick<Professional, 'id' | 'name' | 'serviceIds'>;
export type SpaceLite = Pick<Space, 'id' | 'name' | 'pricePerHourCents'>;

const overlaps = (b: Interval, start: Date, end: Date) => b.s < end && b.e > start;

// ---------- Professionals ----------

/** Active professionals of a tenant (empty = the business works as a single agenda). */
export function activeProfessionals(db: Pick<Db, 'select'>, tenantId: string): Promise<Professional[]> {
  return db
    .select()
    .from(professionals)
    .where(and(eq(professionals.tenantId, tenantId), eq(professionals.active, true)))
    .orderBy(asc(professionals.name));
}

/** Professionals who perform the service (an empty service list means "all services"). */
export function eligibleFor<T extends Pick<Professional, 'serviceIds'>>(pros: T[], serviceId: string | null | undefined): T[] {
  if (!serviceId) return pros;
  return pros.filter((p) => !p.serviceIds?.length || p.serviceIds.includes(serviceId));
}

/**
 * Free professional for [start, end), preferring whoever has the fewest bookings that day
 * (spreads the work), ties broken by name. Appointments without a professional block everyone.
 * Pure function so it can be unit-tested.
 */
export function pickProfessional(pros: ProLite[], busy: ProBusy[], start: Date, end: Date): ProLite | null {
  if (busy.some((b) => b.pid === null && overlaps(b, start, end))) return null;
  const free = pros.filter((p) => !busy.some((b) => b.pid === p.id && overlaps(b, start, end)));
  if (!free.length) return null;
  const load = (id: string) => busy.filter((b) => b.pid === id).length;
  return [...free].sort((a, b) => load(a.id) - load(b.id) || a.name.localeCompare(b.name, 'es'))[0]!;
}

/**
 * Busy intervals per professional in [from, to): their appointments (not classes or rentals)
 * plus the classes they teach.
 */
export async function professionalBusy(db: Pick<Db, 'execute'>, tenantId: string, from: Date, to: Date, excludeId?: string): Promise<ProBusy[]> {
  const exclude = excludeId ? sql`and id <> ${excludeId}` : sql``;
  const res = await db.execute<{ pid: string | null; s: Date | string; e: Date | string }>(sql`
    select professional_id as pid, starts_at as s, ends_at as e from appointments
    where tenant_id = ${tenantId} and status in ('scheduled', 'confirmed')
      and class_session_id is null and space_id is null and table_id is null
      and starts_at < ${to.toISOString()} and ends_at > ${from.toISOString()} ${exclude}
    union all
    select professional_id as pid, starts_at as s, ends_at as e from class_sessions
    where tenant_id = ${tenantId} and status = 'scheduled' and professional_id is not null
      and starts_at < ${to.toISOString()} and ends_at > ${from.toISOString()}`);
  return res.rows.map((r) => ({ pid: r.pid, s: new Date(r.s), e: new Date(r.e) }));
}

/**
 * Picks (or validates) the professional for a booking. Call inside the tenant lock.
 * Throws 404 unknown professional, 422 if they don't do the service, 409 if busy / nobody free.
 */
export async function assignProfessional(
  db: Q,
  tenantId: string,
  serviceId: string,
  start: Date,
  end: Date,
  opts: { professionalId?: string | null; excludeId?: string } = {},
): Promise<Professional> {
  const pros = await activeProfessionals(db, tenantId);
  // A ±12 h window also gives a rough per-day load for spreading bookings.
  const busy = await professionalBusy(db, tenantId, new Date(start.getTime() - 12 * 3600e3), new Date(end.getTime() + 12 * 3600e3), opts.excludeId);
  if (opts.professionalId) {
    const p = pros.find((x) => x.id === opts.professionalId);
    if (!p) throw new AppError(404, 'professional_not_found', 'Professional not found or inactive');
    if (!eligibleFor([p], serviceId).length) throw new AppError(422, 'professional_service', 'That professional does not perform this service');
    if (busy.some((b) => (b.pid === p.id || b.pid === null) && overlaps(b, start, end))) {
      throw new AppError(409, 'professional_busy', 'That professional is busy at that time');
    }
    return p;
  }
  const chosen = pickProfessional(eligibleFor(pros, serviceId), busy, start, end);
  if (!chosen) throw new AppError(409, 'no_professional_available', 'Nobody is available at that time');
  return pros.find((p) => p.id === chosen.id)!;
}

// ---------- Spaces ----------

export function activeSpaces(db: Pick<Db, 'select'>, tenantId: string): Promise<Space[]> {
  return db
    .select()
    .from(spaces)
    .where(and(eq(spaces.tenantId, tenantId), eq(spaces.active, true)))
    .orderBy(asc(spaces.name));
}

/** First free space (by name) for [start, end), or the requested one if it's free. Pure. */
export function pickSpace(list: SpaceLite[], busy: SpaceBusy[], start: Date, end: Date, spaceId?: string | null): SpaceLite | null {
  const candidates = spaceId ? list.filter((s) => s.id === spaceId) : [...list].sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
  return candidates.find((s) => !busy.some((b) => b.sid === s.id && overlaps(b, start, end))) ?? null;
}

export async function spaceBusy(db: Pick<Db, 'execute'>, tenantId: string, from: Date, to: Date, excludeId?: string): Promise<SpaceBusy[]> {
  const exclude = excludeId ? sql`and id <> ${excludeId}` : sql``;
  const res = await db.execute<{ sid: string; s: Date | string; e: Date | string }>(sql`
    select space_id as sid, starts_at as s, ends_at as e from appointments
    where tenant_id = ${tenantId} and space_id is not null and status in ('scheduled', 'confirmed')
      and starts_at < ${to.toISOString()} and ends_at > ${from.toISOString()} ${exclude}`);
  return res.rows.map((r) => ({ sid: r.sid, s: new Date(r.s), e: new Date(r.e) }));
}

/** Validates or picks a space. Call inside the tenant lock. */
export async function assignSpace(
  db: Q,
  tenantId: string,
  start: Date,
  end: Date,
  opts: { spaceId?: string | null; excludeId?: string } = {},
): Promise<Space> {
  const list = await activeSpaces(db, tenantId);
  if (opts.spaceId && !list.some((s) => s.id === opts.spaceId)) throw new AppError(404, 'space_not_found', 'Space not found or inactive');
  const busy = await spaceBusy(db, tenantId, start, end, opts.excludeId);
  const s = pickSpace(list, busy, start, end, opts.spaceId);
  if (!s) throw new AppError(409, opts.spaceId ? 'space_taken' : 'no_space_available', 'No space available at that time');
  return list.find((x) => x.id === s.id)!;
}

// ---------- Internal services ----------

/** Rentals and restaurants book through a single internal service; create it on demand. */
export async function internalService(db: Pick<Db, 'select' | 'insert'>, tenant: Pick<Tenant, 'id'>, name: string, durationMin: number): Promise<Service> {
  const [svc] = await db
    .select()
    .from(services)
    .where(and(eq(services.tenantId, tenant.id), eq(services.active, true)))
    .orderBy(asc(services.createdAt))
    .limit(1);
  if (svc) return svc;
  const [created] = await db.insert(services).values({ tenantId: tenant.id, name, durationMin, priceCents: 0 }).returning();
  return created!;
}

export const RENTAL_SERVICE_NAME = 'Renta de espacio';

/** Starter spaces for a new rental business, named after its type. */
export function defaultSpaces(type: string): { name: string; pricePerHourCents: number }[] {
  if (type === 'sports') return [{ name: 'Cancha 1', pricePerHourCents: 0 }, { name: 'Cancha 2', pricePerHourCents: 0 }];
  if (type === 'coworking') return [{ name: 'Sala de juntas', pricePerHourCents: 0 }];
  return [{ name: 'Estudio A', pricePerHourCents: 0 }];
}
