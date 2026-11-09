import { createMiddleware } from 'hono/factory';
import { and, eq } from 'drizzle-orm';
import { isManager, type Role } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { memberships, users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { verifyToken } from '../lib/auth.js';

export interface AuthVars {
  userId: string;
  /** Always taken from the verified token, never from the request body/query. */
  tenantId: string;
  /** Current role in this business, read from the database so changes and removals apply immediately. */
  role: Role;
  /** Location this login is limited to in this business (null = all locations). */
  locationId: string | null;
}

export type AppEnv = { Variables: AuthVars };

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) throw new AppError(401, 'unauthorized');
  let claims;
  try {
    claims = await verifyToken(token);
  } catch {
    throw new AppError(401, 'unauthorized', 'Invalid or expired token');
  }
  const [m] = await getDb()
    .select({ role: memberships.role, locationId: memberships.locationId, passwordChangedAt: users.passwordChangedAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.userId, claims.sub), eq(memberships.tenantId, claims.tid)))
    .limit(1);
  if (!m) throw new AppError(401, 'unauthorized', 'No access to this business');
  // A password reset signs out every session opened before it.
  if (m.passwordChangedAt && (claims.iat ?? 0) < Math.floor(m.passwordChangedAt.getTime() / 1000)) {
    throw new AppError(401, 'unauthorized', 'Session ended after a password change');
  }
  c.set('userId', claims.sub);
  c.set('tenantId', claims.tid);
  c.set('role', m.role);
  c.set('locationId', m.locationId);
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
