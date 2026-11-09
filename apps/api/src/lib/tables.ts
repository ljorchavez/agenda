import { and, asc, eq, gte, sql } from 'drizzle-orm';
import { reservationSettingsOf } from '@agenda/shared';
import type { Db } from '../db/client.js';
import { diningTables, services, type DiningTable, type Service, type Tenant } from '../db/schema.js';
import { AppError } from './errors.js';

type Busy = { tableId: string; s: Date; e: Date };
type TableLite = Pick<DiningTable, 'id' | 'name' | 'seats'>;

/**
 * Smallest free table that fits the party (ties broken by name), or null.
 * Pure function so it can be unit-tested.
 */
export function pickTable(tables: TableLite[], busy: Busy[], partySize: number, start: Date, end: Date): TableLite | null {
  const fitting = tables
    .filter((t) => t.seats >= partySize)
    .sort((a, b) => a.seats - b.seats || a.name.localeCompare(b.name, 'es', { numeric: true }));
  for (const t of fitting) {
    if (!busy.some((b) => b.tableId === t.id && b.s < end && b.e > start)) return t;
  }
  return null;
}

/** Active tables with enough seats, plus their active reservations overlapping [from, to). */
export async function loadTableState(
  db: Pick<Db, 'select' | 'execute'>,
  tenantId: string,
  partySize: number,
  from: Date,
  to: Date,
  excludeId?: string,
  locationId?: string,
): Promise<{ tables: TableLite[]; busy: Busy[] }> {
  const tables = await db
    .select({ id: diningTables.id, name: diningTables.name, seats: diningTables.seats })
    .from(diningTables)
    .where(and(
      eq(diningTables.tenantId, tenantId),
      eq(diningTables.active, true),
      gte(diningTables.seats, partySize),
      locationId ? eq(diningTables.locationId, locationId) : undefined,
    ));
  if (!tables.length) return { tables, busy: [] };
  const exclude = excludeId ? sql`and id <> ${excludeId}` : sql``;
  const res = await db.execute<{ table_id: string; starts_at: Date | string; ends_at: Date | string }>(sql`
    select table_id, starts_at, ends_at from appointments
    where tenant_id = ${tenantId} and table_id is not null
      and status in ('scheduled', 'confirmed')
      and starts_at < ${to.toISOString()} and ends_at > ${from.toISOString()} ${exclude}`);
  return {
    tables,
    busy: res.rows.map((r) => ({ tableId: r.table_id, s: new Date(r.starts_at), e: new Date(r.ends_at) })),
  };
}

/** Finds a free table for the party, or throws 409 `no_table_available`. Call inside the tenant lock. */
export async function assignTable(
  db: Pick<Db, 'select' | 'execute'>,
  tenantId: string,
  partySize: number,
  start: Date,
  end: Date,
  opts: { excludeId?: string; tableId?: string | null; locationId?: string } = {},
): Promise<TableLite> {
  const { tables, busy } = await loadTableState(db, tenantId, partySize, start, end, opts.excludeId, opts.locationId);
  if (opts.tableId) {
    const wanted = tables.find((t) => t.id === opts.tableId);
    if (!wanted) throw new AppError(422, 'table_too_small', 'That table is inactive or too small for the party');
    if (busy.some((b) => b.tableId === wanted.id && b.s < end && b.e > start)) {
      throw new AppError(409, 'table_taken', 'That table is already reserved at that time');
    }
    return wanted;
  }
  const t = pickTable(tables, busy, partySize, start, end);
  if (!t) throw new AppError(409, 'no_table_available', 'No table available for that party size and time');
  return t;
}

/** Restaurants book a single "Reservación" service; create it on demand. */
export async function reservationService(db: Pick<Db, 'select' | 'insert'>, tenant: Tenant): Promise<Service> {
  const [svc] = await db
    .select()
    .from(services)
    .where(and(eq(services.tenantId, tenant.id), eq(services.active, true)))
    .orderBy(asc(services.createdAt))
    .limit(1);
  if (svc) return svc;
  const [created] = await db
    .insert(services)
    .values({
      tenantId: tenant.id,
      name: 'Reservación',
      durationMin: reservationSettingsOf(tenant.settings).durationMin,
      priceCents: 0,
    })
    .returning();
  return created!;
}

/** Starter tables for a new restaurant so online booking works right away. */
export const DEFAULT_TABLES = [
  { name: 'Mesa 1', seats: 2 },
  { name: 'Mesa 2', seats: 2 },
  { name: 'Mesa 3', seats: 4 },
  { name: 'Mesa 4', seats: 4 },
  { name: 'Mesa 5', seats: 6 },
];
