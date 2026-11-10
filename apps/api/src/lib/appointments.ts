import { sql, type SQL } from 'drizzle-orm';
import type { AppointmentDto } from '@agenda/shared';
import type { Db } from '../db/client.js';
import { toAppointmentDto, type AppointmentRow } from './mappers.js';

/** Appointment rows joined with customer/service names and paid amount, scoped by tenant. */
export async function queryAppointments(
  db: Db,
  tenantId: string,
  where: SQL,
  orderLimit: SQL = sql`order by a.starts_at asc limit 1000`,
): Promise<AppointmentDto[]> {
  const res = await db.execute<AppointmentRow>(sql`
    select a.id, a.customer_id, c.name as customer_name, c.phone as customer_phone,
           a.service_id, s.name as service_name, a.staff_user_id,
           a.starts_at, a.ends_at, a.status, a.price_cents, a.source, a.notes, a.rating,
           a.party_size, a.resource_id, r.name as resource_name, r.color as resource_color,
           a.class_session_id, a.location_id,
           coalesce((select sum(p.amount_cents) from payments p
                     where p.appointment_id = a.id and p.tenant_id = a.tenant_id
                       and p.status = 'paid'), 0) as paid_cents,
           (select array_agg(distinct p.method::text) from payments p
             where p.appointment_id = a.id and p.tenant_id = a.tenant_id
               and p.status = 'paid') as paid_methods
    from appointments a
    join customers c on c.id = a.customer_id
    join services s on s.id = a.service_id
    left join resources r on r.id = a.resource_id and r.tenant_id = a.tenant_id
    where a.tenant_id = ${tenantId} and ${where}
    ${orderLimit}`);
  return res.rows.map(toAppointmentDto);
}

/**
 * Returns true if [startsAt, endsAt) overlaps an active appointment.
 * Single agenda (a location without resources). When `staffUserId` is undefined, checks the
 * whole location. Class sign-ups and bookings with a resource follow the resource rules instead.
 */
export async function hasOverlap(
  db: Pick<Db, 'execute'>,
  tenantId: string,
  startsAt: Date,
  endsAt: Date,
  opts: { staffUserId?: string | null; excludeId?: string; locationId?: string } = {},
): Promise<boolean> {
  const staffFilter =
    opts.staffUserId === undefined
      ? sql``
      : opts.staffUserId === null
        ? sql`and staff_user_id is null`
        : sql`and staff_user_id = ${opts.staffUserId}`;
  const exclude = opts.excludeId ? sql`and id <> ${opts.excludeId}` : sql``;
  const loc = opts.locationId ? sql`and location_id = ${opts.locationId}` : sql``;
  const res = await db.execute(sql`
    select 1 from appointments
    where tenant_id = ${tenantId}
      and status in ('scheduled', 'confirmed')
      and starts_at < ${endsAt.toISOString()} and ends_at > ${startsAt.toISOString()}
      and class_session_id is null and resource_id is null
      ${staffFilter} ${exclude} ${loc}
    limit 1`);
  return res.rows.length > 0;
}
