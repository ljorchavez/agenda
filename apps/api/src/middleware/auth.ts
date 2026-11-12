import { createMiddleware } from 'hono/factory';
import { and, eq } from 'drizzle-orm';
import { isManager, type Role } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { memberships, tenants, users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { verifyToken } from '../lib/auth.js';
import { CSRF_HEADER, sessionCookie } from '../lib/session.js';
import { isReadOnly } from '../lib/billing.js';

export interface AuthVars {
  userId: string;
  /** Always taken from the verified token, never from the request body/query. */
  tenantId: string;
  /** Current role in this business, read from the database so changes and removals apply immediately. */
  role: Role;
  /** Location this login is limited to in this business (null = all locations). */
  locationId: string | null;
  /** How the request proved who it is */
  authVia: 'cookie' | 'bearer';
}

export type AppEnv = { Variables: AuthVars };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** What still works while a business is read-only for an unpaid subscription. */
const READ_ONLY_ALLOWED = [/^\/api\/auth\//, /^\/api\/tenant\/(plan|billing|export|delete)/];

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('authorization');
  const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  const token = bearer ?? sessionCookie(c);
  if (!token) throw new AppError(401, 'unauthorized');
  // Cookie sessions must come from our own app when they change something (CSRF).
  if (!bearer && !SAFE_METHODS.has(c.req.method) && !c.req.header(CSRF_HEADER)) {
    throw new AppError(403, 'forbidden', 'Missing X-Requested-With header');
  }
  let claims;
  try {
    claims = await verifyToken(token);
  } catch {
    throw new AppError(401, 'unauthorized', 'Invalid or expired token');
  }
  const [m] = await getDb()
    .select({
      role: memberships.role,
      locationId: memberships.locationId,
      passwordChangedAt: users.passwordChangedAt,
      billingStatus: tenants.billingStatus,
      billingPastDueSince: tenants.billingPastDueSince,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
    .where(and(eq(memberships.userId, claims.sub), eq(memberships.tenantId, claims.tid)))
    .limit(1);
  if (!m) throw new AppError(401, 'unauthorized', 'No access to this business');
  // A password reset signs out every session opened before it.
  if (m.passwordChangedAt && (claims.iat ?? 0) < Math.floor(m.passwordChangedAt.getTime() / 1000)) {
    throw new AppError(401, 'unauthorized', 'Session ended after a password change');
  }
  if (
    !SAFE_METHODS.has(c.req.method) &&
    isReadOnly({ billingStatus: m.billingStatus, billingPastDueSince: m.billingPastDueSince }) &&
    !READ_ONLY_ALLOWED.some((r) => r.test(c.req.path))
  ) {
    throw new AppError(402, 'billing_read_only', 'The subscription payment failed; update the card to keep working');
  }
  c.set('userId', claims.sub);
  c.set('tenantId', claims.tid);
  c.set('role', m.role);
  c.set('locationId', m.locationId);
  c.set('authVia', bearer ? 'bearer' : 'cookie');
  await next();
});

export const requireOwner = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('role') !== 'owner') throw new AppError(403, 'forbidden', 'Owner role required');
  await next();
});

/** Owners and admins. */
export const requireManager = createMiddleware<AppEnv>(async (c, next) => {
  if (!isManager(c.get('role'))) throw new AppError(403, 'forbidden', 'Owner or admin role required');
  await next();
});

/** Owners and admins with access to every location (business-wide settings, catalogue, locations). */
export const requireBusinessManager = createMiddleware<AppEnv>(async (c, next) => {
  const role = c.get('role');
  if (!isManager(role) || (role !== 'owner' && c.get('locationId'))) {
    throw new AppError(403, 'forbidden', 'Business-wide manager role required');
  }
  await next();
});
