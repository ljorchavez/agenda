import { and, eq, sql, type SQL } from 'drizzle-orm';
import { businessKind } from '@agenda/shared';
import type { Context } from 'hono';
import type { Db } from '../db/client.js';
import { professionals, tenants } from '../db/schema.js';
import { AppError } from './errors.js';
import type { AppEnv } from '../middleware/auth.js';

/**
 * What a logged-in user may see.
 * - Owners and admins: everything.
 * - Staff ("colaboradores"): only bookings of the team member linked to their login
 *   (plus anything assigned directly to their user). In restaurants and rentals there are no
 *   per-person bookings, so unlinked staff (hosts, front desk) see the whole book.
 */
export type Scope = { all: true } | { all: false; userId: string; professionalId: string | null };

export async function getScope(db: Pick<Db, 'query'>, c: Context<AppEnv>): Promise<Scope> {
  if (c.get('role') !== 'staff') return { all: true };
  const tenantId = c.get('tenantId');
  const userId = c.get('userId');
  const [tenant, pro] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, tenantId), columns: { businessType: true } }),
    db.query.professionals.findFirst({
      where: and(eq(professionals.tenantId, tenantId), eq(professionals.userId, userId)),
      columns: { id: true },
    }),
  ]);
  const kind = tenant ? businessKind(tenant.businessType) : 'appointments';
  if (!pro && (kind === 'reservations' || kind === 'rentals')) return { all: true };
  return { all: false, userId, professionalId: pro?.id ?? null };
}

/** `and (...)` restricting an appointments alias to the scope (empty for full access). */
export function scopeSql(scope: Scope, alias = 'a'): SQL {
  if (scope.all) return sql``;
  const a = sql.raw(alias);
  const pro = scope.professionalId
    ? sql` or ${a}.professional_id = ${scope.professionalId}
           or exists (select 1 from class_sessions scs where scs.id = ${a}.class_session_id and scs.professional_id = ${scope.professionalId})`
    : sql``;
  return sql`and (${a}.staff_user_id = ${scope.userId}${pro})`;
}

/** Same check for a row already loaded. */
export function inScope(
  scope: Scope,
  row: { staffUserId: string | null; professionalId: string | null },
  sessionProfessionalId?: string | null,
): boolean {
  if (scope.all) return true;
  if (row.staffUserId === scope.userId) return true;
  if (!scope.professionalId) return false;
  return row.professionalId === scope.professionalId || sessionProfessionalId === scope.professionalId;
}

/** Payments are visible to staff only through their own bookings. */
export function paymentScopeSql(scope: Scope, paymentAlias = 'p'): SQL {
  if (scope.all) return sql``;
  const p = sql.raw(paymentAlias);
  return sql`and exists (select 1 from appointments a where a.id = ${p}.appointment_id and a.tenant_id = ${p}.tenant_id ${scopeSql(scope, 'a')})`;
}

export const forbiddenScope = () => new AppError(403, 'not_yours', 'That booking belongs to someone else');
