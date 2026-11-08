import { createMiddleware } from 'hono/factory';
import type { Role } from '@agenda/shared';
import { AppError } from '../lib/errors.js';
import { verifyToken } from '../lib/auth.js';

export interface AuthVars {
  userId: string;
  /** Always taken from the verified token, never from the request body/query. */
  tenantId: string;
  role: Role;
}

export type AppEnv = { Variables: AuthVars };

export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) throw new AppError(401, 'unauthorized');
  try {
    const claims = await verifyToken(token);
    c.set('userId', claims.sub);
    c.set('tenantId', claims.tid);
    c.set('role', claims.role);
  } catch {
    throw new AppError(401, 'unauthorized', 'Invalid or expired token');
  }
  await next();
});

export const requireOwner = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get('role') !== 'owner') throw new AppError(403, 'forbidden', 'Owner role required');
  await next();
});
