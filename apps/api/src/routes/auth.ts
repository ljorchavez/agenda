import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_TENANT_SETTINGS,
  loginSchema,
  normalizeMxPhone,
  registerSchema,
  staffCreateSchema,
  tenantUpdateSchema,
  type AuthResponse,
} from '@agenda/shared';
import { getDb } from '../db/client.js';
import { tenants, users } from '../db/schema.js';
import { hashPassword, signToken, slugify, verifyPassword } from '../lib/auth.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { toTenantDto } from '../lib/mappers.js';
import { requireAuth, requireOwner, type AppEnv } from '../middleware/auth.js';

export const authRoutes = new Hono<AppEnv>();

async function uniqueSlug(base: string): Promise<string> {
  const db = getDb();
  const root = slugify(base) || 'negocio';
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? root : `${root}-${Math.random().toString(36).slice(2, 6)}`;
    const existing = await db.query.tenants.findFirst({ where: eq(tenants.slug, candidate) });
    if (!existing) return candidate;
  }
  throw new AppError(500, 'slug_generation_failed');
}

authRoutes.post('/auth/register', async (c) => {
  const input = registerSchema.parse(await c.req.json());
  const db = getDb();

  const existing = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  if (existing) throw conflict('email_taken', 'Email already registered');

  const slug = await uniqueSlug(input.businessName);
  const passwordHash = await hashPassword(input.password);

  const result = await db.transaction(async (tx) => {
    const [tenant] = await tx
      .insert(tenants)
      .values({
        name: input.businessName,
        slug,
        businessType: input.businessType,
        phone: input.phone ? normalizeMxPhone(input.phone) : null,
        locale: input.locale,
        settings: DEFAULT_TENANT_SETTINGS,
      })
      .returning();
    const [user] = await tx
      .insert(users)
      .values({
        tenantId: tenant!.id,
        email: input.email,
        passwordHash,
        name: input.name,
        role: 'owner',
      })
      .returning();
    return { tenant: tenant!, user: user! };
  });

  const token = await signToken({ sub: result.user.id, tid: result.tenant.id, role: 'owner' });
  const body: AuthResponse = {
    token,
    user: { id: result.user.id, name: result.user.name, email: result.user.email, role: 'owner' },
    tenant: toTenantDto(result.tenant),
  };
  return c.json(body, 201);
});

authRoutes.post('/auth/login', async (c) => {
  const input = loginSchema.parse(await c.req.json());
  const db = getDb();
  const user = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  // Same error for unknown email and wrong password to avoid account enumeration.
  if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
    throw new AppError(401, 'invalid_credentials', 'Invalid email or password');
  }
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, user.tenantId) });
  if (!tenant) throw notFound('tenant');
  const token = await signToken({ sub: user.id, tid: tenant.id, role: user.role });
  const body: AuthResponse = {
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    tenant: toTenantDto(tenant),
  };
  return c.json(body);
});

// ---------- Authenticated ----------

authRoutes.get('/auth/me', requireAuth, async (c) => {
  const db = getDb();
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, c.get('userId')), eq(users.tenantId, c.get('tenantId'))),
  });
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, c.get('tenantId')) });
  if (!user || !tenant) throw new AppError(401, 'unauthorized');
  return c.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    tenant: toTenantDto(tenant),
  });
});

authRoutes.patch('/tenant', requireAuth, requireOwner, async (c) => {
  const input = tenantUpdateSchema.parse(await c.req.json());
  const db = getDb();
  const [tenant] = await db
    .update(tenants)
    .set({
      ...input,
      phone: input.phone === undefined ? undefined : input.phone && normalizeMxPhone(input.phone),
    })
    .where(eq(tenants.id, c.get('tenantId')))
    .returning();
  if (!tenant) throw notFound('tenant');
  return c.json(toTenantDto(tenant));
});

authRoutes.get('/users', requireAuth, async (c) => {
  const rows = await getDb()
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.tenantId, c.get('tenantId')))
    .orderBy(users.name);
  return c.json(rows);
});

authRoutes.post('/users', requireAuth, requireOwner, async (c) => {
  const input = staffCreateSchema.parse(await c.req.json());
  const db = getDb();
  const existing = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  if (existing) throw conflict('email_taken', 'Email already registered');
  const [user] = await db
    .insert(users)
    .values({
      tenantId: c.get('tenantId'),
      email: input.email,
      name: input.name,
      role: input.role,
      passwordHash: await hashPassword(input.password),
    })
    .returning({ id: users.id, name: users.name, email: users.email, role: users.role });
  return c.json(user, 201);
});
