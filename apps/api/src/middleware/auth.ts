import { createMiddleware } from 'hono/factory';
import { and, eq } from 'drizzle-orm';
import { isManager, type Role } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import { verifyToken } from '../lib/auth.js';

export interface AuthVars {
  userId: string;
  /** Always taken from the verified token, never from the request body/query. */
  tenantId: string;
  /** Current role, read from the database so role changes and removals apply immediately. */
  role: Role;
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
  const user = await getDb().query.users.findFirst({
    where: and(eq(users.id, claims.sub), eq(users.tenantId, claims.tid)),
    columns: { role: true },
  });
  if (!user) throw new AppError(401, 'unauthorized', 'User no longer exists');
  c.set('userId', claims.sub);
  c.set('tenantId', claims.tid);
  c.set('role', user.role);
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
