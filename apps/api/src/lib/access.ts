import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';
import type { Db } from '../db/client.js';
import { resources } from '../db/schema.js';
import { AppError } from './errors.js';
import type { AppEnv } from '../middleware/auth.js';

/**
 * What a logged-in user may see in the current business.
 * - Owners: everything.
 * - Admins: everything, or one location when their access is limited to it (gerente de sucursal).
 * - Staff ("colaboradores") linked to a resource (barber, instructor): only its bookings (plus
 *   anything assigned directly to their user). Staff not linked to any resource (hosts, front
 *   desk) see the whole book of their location. Same rule for every kind of business.
 */
export interface Scope {
  /** No restriction at all */
  all: boolean;
  /** Limited to one location */
  locationId: string | null;
  /** Only their own bookings */
  personal: boolean;
  userId: string;
  /** Resource linked to the login */
  resourceId: string | null;
}

export async function getScope(db: Pick<Db, 'query'>, c: Context<AppEnv>): Promise<Scope> {
  const role = c.get('role');
  const userId = c.get('userId');
  const locationId = role === 'owner' ? null : c.get('locationId') ?? null;
  if (role !== 'staff') return { all: !locationId, locationId, personal: false, userId, resourceId: null };
  const res = await db.query.resources.findFirst({
    where: and(eq(resources.tenantId, c.get('tenantId')), eq(resources.userId, userId)),
    columns: { id: true },
  });
  // Front desk / hosts (no resource of their own) work with the whole book of their location.
  if (!res) return { all: !locationId, locationId, personal: false, userId, resourceId: null };
  return { all: false, locationId, personal: true, userId, resourceId: res.id };
}

/** `and (...)` restricting an appointments alias to the scope (empty for full access). */
export function scopeSql(scope: Scope, alias = 'a'): SQL {
  if (scope.all) return sql``;
  const a = sql.raw(alias);
  const loc = scope.locationId ? sql` and ${a}.location_id = ${scope.locationId}` : sql``;
  if (!scope.personal) return loc;
  const res = scope.resourceId
    ? sql` or ${a}.resource_id = ${scope.resourceId}
           or exists (select 1 from class_sessions scs where scs.id = ${a}.class_session_id and scs.resource_id = ${scope.resourceId})`
    : sql``;
  return sql`${loc} and (${a}.staff_user_id = ${scope.userId}${res})`;
}

/** Same check for a row already loaded. */
export function inScope(
  scope: Scope,
  row: { staffUserId: string | null; resourceId: string | null; locationId: string },
  sessionResourceId?: string | null,
): boolean {
  if (scope.all) return true;
  if (scope.locationId && row.locationId !== scope.locationId) return false;
  if (!scope.personal) return true;
  if (row.staffUserId === scope.userId) return true;
  if (!scope.resourceId) return false;
  return row.resourceId === scope.resourceId || sessionResourceId === scope.resourceId;
}

/** Location-limited logins can only work in their own location. */
export function assertLocation(scope: Scope, locationId: string | null | undefined) {
  if (scope.locationId && locationId && locationId !== scope.locationId) throw forbiddenScope();
}

/** `and ...` restricting a located table alias (resources, class sessions) to the scope's location. */
export function locationSql(scope: Scope, alias: string): SQL {
  return scope.locationId ? sql` and ${sql.raw(alias)}.location_id = ${scope.locationId}` : sql``;
}

/** Payments are visible to restricted logins only through their own bookings. */
export function paymentScopeSql(scope: Scope, paymentAlias = 'p'): SQL {
  if (scope.all) return sql``;
  const p = sql.raw(paymentAlias);
  return sql`and exists (select 1 from appointments a where a.id = ${p}.appointment_id and a.tenant_id = ${p}.tenant_id ${scopeSql(scope, 'a')})`;
}

export const forbiddenScope = () => new AppError(403, 'not_yours', 'That booking belongs to someone else');
