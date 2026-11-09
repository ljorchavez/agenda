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
           a.starts_at, a.ends_at, a.status, a.price_cents, a.source, a.notes,
           a.party_size, a.table_id, t.name as table_name,
           a.professional_id, pr.name as professional_name, pr.color as professional_color,
           a.space_id, sp.name as space_name, a.class_session_id,
           coalesce((select sum(p.amount_cents) from payments p
                     where p.appointment_id = a.id and p.tenant_id = a.tenant_id
                       and p.status = 'paid'), 0) as paid_cents
    from appointments a
    join customers c on c.id = a.customer_id
    join services s on s.id = a.service_id
    left join dining_tables t on t.id = a.table_id and t.tenant_id = a.tenant_id
    left join professionals pr on pr.id = a.professional_id and pr.tenant_id = a.tenant_id
    left join spaces sp on sp.id = a.space_id and sp.tenant_id = a.tenant_id
    where a.tenant_id = ${tenantId} and ${where}
    ${orderLimit}`);
  return res.rows.map(toAppointmentDto);
}

/**
 * Returns true if [startsAt, endsAt) overlaps an active appointment.
 * When `staffUserId` is undefined, checks the whole business (single-capacity).
 * Class attendees, rentals and table reservations have their own capacity rules and are ignored.
 */
export async function hasOverlap(
  db: Pick<Db, 'execute'>,
  tenantId: string,
  startsAt: Date,
  endsAt: Date,
  opts: { staffUserId?: string | null; excludeId?: string } = {},
): Promise<boolean> {
  const staffFilter =
    opts.staffUserId === undefined
      ? sql``
      : opts.staffUserId === null
        ? sql`and staff_user_id is null`
        : sql`and staff_user_id = ${opts.staffUserId}`;
  const exclude = opts.excludeId ? sql`and id <> ${opts.excludeId}` : sql``;
  const res = await db.execute(sql`
    select 1 from appointments
    where tenant_id = ${tenantId}
      and status in ('scheduled', 'confirmed')
      and starts_at < ${endsAt.toISOString()} and ends_at > ${startsAt.toISOString()}
      and class_session_id is null and space_id is null and table_id is null
      ${staffFilter} ${exclude}
    limit 1`);
  return res.rows.length > 0;
}
