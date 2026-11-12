import { Hono } from 'hono';
import { del } from '@vercel/blob';
import { and, eq, sql } from 'drizzle-orm';
import { tenantDeleteSchema } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { memberships, recordPhotos, tenants, users } from '../db/schema.js';
import { verifyPassword } from '../lib/auth.js';
import { billingProvider, isDemoSlug } from '../lib/billing.js';
import { decryptSecret } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { clearSessionCookie } from '../lib/session.js';
import { assertNotLimited, recordAttempt } from '../lib/throttle.js';
import { requireAuth, requireOwner, type AppEnv } from '../middleware/auth.js';
import { photoToken } from './records.js';

/**
 * The business's own data (LFPDPPP, derechos ARCO): the owner can download everything and can
 * delete the business for good.
 */
export const accountRoutes = new Hono<AppEnv>();

/** Keys and secrets never leave the server, not even in the owner's export. */
const SECRET_COLUMNS = new Set(['mp_access_token_enc', 'invoicing_enc', 'totp_secret_enc', 'password_hash', 'totp_recovery']);

function readable(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (SECRET_COLUMNS.has(k)) continue;
    if (k.endsWith('_enc') && typeof v === 'string') {
      let plain: unknown;
      try {
        plain = decryptSecret(v);
        if (typeof plain === 'string' && /^[[{]/.test(plain)) plain = JSON.parse(plain);
      } catch {
        plain = null;
      }
      out[k.slice(0, -4)] = plain;
    } else {
      out[k] = v;
    }
  }
  return out;
}

accountRoutes.get('/tenant/export', requireAuth, requireOwner, async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const [tenant] = (await db.execute(sql`select * from tenants where id = ${tenantId}`)).rows as Record<string, unknown>[];
  if (!tenant) throw new AppError(404, 'not_found');
  const tables = await db.execute<{ table_name: string }>(sql`
    select distinct c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
      and c.table_name <> 'error_events'
    order by 1`);
  const data: Record<string, unknown[]> = {};
  for (const { table_name } of tables.rows) {
    const rows = await db.execute(sql`select * from ${sql.identifier(table_name)} where tenant_id = ${tenantId}`);
    data[table_name] = (rows.rows as Record<string, unknown>[]).map(readable);
  }
  const team = await db.execute(sql`
    select u.name, u.email, m.role, m.created_at from memberships m join users u on u.id = m.user_id
    where m.tenant_id = ${tenantId} order by m.created_at`);
  const date = new Date().toISOString().slice(0, 10);
  const body = JSON.stringify({ exportedAt: new Date().toISOString(), tenant: readable(tenant), team: team.rows, data }, null, 1);
  return c.body(body, 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="lugali-${String(tenant.slug)}-${date}.json"`,
    'Cache-Control': 'no-store',
  });
});

/**
 * Deletes the business and everything in it (bookings, customers, records, files). Asks for the
 * owner's password and the business name typed out. Logins left without any business go too.
 */
accountRoutes.post('/tenant/delete', requireAuth, requireOwner, async (c) => {
  const { password, confirmName } = tenantDeleteSchema.parse(await c.req.json());
  const db = getDb();
  const tenantId = c.get('tenantId');
  const userId = c.get('userId');
  const limits = [{ key: `delete-tenant:${userId}`, max: 5, minutes: 60 }];
  await assertNotLimited(db, limits);
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!tenant || !user) throw new AppError(404, 'not_found');
  if (isDemoSlug(tenant.slug)) throw new AppError(403, 'demo_account', 'The demo businesses cannot be deleted');
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
  if (norm(confirmName) !== norm(tenant.name) || !(await verifyPassword(password, user.passwordHash))) {
    await recordAttempt(db, limits);
    throw new AppError(422, 'delete_not_confirmed', 'Wrong password or business name');
  }

  // Stop charging the card first.
  const billing = billingProvider();
  if (billing && tenant.billingSubscriptionId) {
    await billing.cancel(tenant.billingSubscriptionId).catch((e) => console.warn('[billing] cancel on delete failed:', e));
  }
  // Private files (record photos, studies). Public images (logo, photos) are left: they're unlisted.
  const token = photoToken();
  if (token) {
    const files = await db.select({ url: recordPhotos.blobPath }).from(recordPhotos).where(eq(recordPhotos.tenantId, tenantId));
    for (let i = 0; i < files.length; i += 100) {
      await del(files.slice(i, i + 100).map((f) => f.url), { token }).catch((e) => console.warn('[delete] blob cleanup failed:', e));
    }
  }
  const members = await db.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.tenantId, tenantId));
  await db.transaction(async (tx) => {
    await tx.delete(tenants).where(eq(tenants.id, tenantId));
    for (const m of members) {
      const other = await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.userId, m.userId)).limit(1);
      if (!other.length) await tx.delete(users).where(eq(users.id, m.userId));
    }
  });
  const left = await db.select({ id: memberships.tenantId }).from(memberships).where(and(eq(memberships.userId, userId)));
  clearSessionCookie(c);
  return c.json({ ok: true, otherBusinesses: left.length });
});
