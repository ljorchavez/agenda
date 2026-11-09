import { sql, type SQL } from 'drizzle-orm';
import type { ClassSessionDto, PublicClassSessionDto } from '@agenda/shared';
import type { Db } from '../db/client.js';
import type { ClassSession } from '../db/schema.js';
import { AppError, notFound } from './errors.js';

/** Statuses that hold a spot in a class (attended or not, only cancellations free it). */
export const HOLDS_SPOT = sql`('scheduled', 'confirmed', 'completed', 'no_show')`;

type Row = {
  id: string;
  service_id: string;
  service_name: string;
  price_cents: number | string;
  professional_id: string | null;
  professional_name: string | null;
  professional_color: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  capacity: number | string;
  status: string;
  notes: string | null;
  booked: number | string;
  location_id: string;
};

/** Sessions with their class type, instructor and spots taken, scoped by tenant. */
export async function querySessions(db: Pick<Db, 'execute'>, tenantId: string, where: SQL, limit = 1000): Promise<ClassSessionDto[]> {
  const res = await db.execute<Row>(sql`
    select cs.id, cs.service_id, s.name as service_name, s.price_cents,
           cs.professional_id, p.name as professional_name, p.color as professional_color,
           cs.starts_at, cs.ends_at, cs.capacity, cs.status, cs.notes, cs.location_id,
           coalesce((select sum(coalesce(a.party_size, 1)) from appointments a
                     where a.class_session_id = cs.id and a.tenant_id = cs.tenant_id
                       and a.status in ${HOLDS_SPOT}), 0) as booked
    from class_sessions cs
    join services s on s.id = cs.service_id and s.tenant_id = cs.tenant_id
    left join professionals p on p.id = cs.professional_id and p.tenant_id = cs.tenant_id
    where cs.tenant_id = ${tenantId} and ${where}
    order by cs.starts_at asc limit ${limit}`);
  return res.rows.map((r) => ({
    id: r.id,
    serviceId: r.service_id,
    serviceName: r.service_name,
    professionalId: r.professional_id,
    professionalName: r.professional_name,
    professionalColor: r.professional_color,
    startsAt: new Date(r.starts_at).toISOString(),
    endsAt: new Date(r.ends_at).toISOString(),
    capacity: Number(r.capacity),
    booked: Number(r.booked),
    status: r.status as ClassSessionDto['status'],
    priceCents: Number(r.price_cents),
    notes: r.notes,
    locationId: r.location_id,
  }));
}

export const toPublicSession = (s: ClassSessionDto): PublicClassSessionDto => ({
  id: s.id,
  locationId: s.locationId,
  serviceId: s.serviceId,
  serviceName: s.serviceName,
  professionalName: s.professionalName,
  startsAt: s.startsAt,
  endsAt: s.endsAt,
  capacity: s.capacity,
  spotsLeft: Math.max(0, s.capacity - s.booked),
  priceCents: s.priceCents,
});

/**
 * Locks the session row and returns it with the spots taken. Use inside a transaction so two
 * people can't take the last spot at the same time.
 */
export async function lockSession(
  tx: Pick<Db, 'execute'>,
  tenantId: string,
  id: string,
  excludeAppointmentId?: string,
): Promise<{ session: ClassSession; booked: number }> {
  const res = await tx.execute<{
    id: string; tenant_id: string; service_id: string; professional_id: string | null;
    starts_at: Date | string; ends_at: Date | string; capacity: number; status: string; notes: string | null;
    created_at: Date | string; updated_at: Date | string; location_id: string;
  }>(sql`select * from class_sessions where id = ${id} and tenant_id = ${tenantId} for update`);
  const r = res.rows[0];
  if (!r) throw notFound('class_session');
  const exclude = excludeAppointmentId ? sql`and id <> ${excludeAppointmentId}` : sql``;
  const b = await tx.execute<{ booked: string | number | null }>(sql`
    select coalesce(sum(coalesce(party_size, 1)), 0) as booked from appointments
    where class_session_id = ${id} and tenant_id = ${tenantId} and status in ${HOLDS_SPOT} ${exclude}`);
  return {
    session: {
      id: r.id,
      tenantId: r.tenant_id,
      serviceId: r.service_id,
      professionalId: r.professional_id,
      startsAt: new Date(r.starts_at),
      endsAt: new Date(r.ends_at),
      capacity: Number(r.capacity),
      status: r.status,
      notes: r.notes,
      locationId: r.location_id,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    },
    booked: Number(b.rows[0]?.booked ?? 0),
  };
}

/** Throws 409 `class_full` when `spots` don't fit. */
export function assertRoom(capacity: number, booked: number, spots: number) {
  if (booked + spots > capacity) {
    throw new AppError(409, 'class_full', `Only ${Math.max(0, capacity - booked)} spots left`);
  }
}

/** True if the instructor teaches or attends something else in [start, end). */
export async function instructorBusy(
  db: Pick<Db, 'execute'>,
  tenantId: string,
  professionalId: string,
  start: Date,
  end: Date,
  excludeSessionId?: string,
): Promise<boolean> {
  const exclude = excludeSessionId ? sql`and id <> ${excludeSessionId}` : sql``;
  const res = await db.execute(sql`
    select 1 from class_sessions
    where tenant_id = ${tenantId} and professional_id = ${professionalId} and status = 'scheduled'
      and starts_at < ${end.toISOString()} and ends_at > ${start.toISOString()} ${exclude}
    union all
    select 1 from appointments
    where tenant_id = ${tenantId} and professional_id = ${professionalId}
      and status in ('scheduled', 'confirmed') and class_session_id is null
      and starts_at < ${end.toISOString()} and ends_at > ${start.toISOString()}
    limit 1`);
  return res.rows.length > 0;
}
