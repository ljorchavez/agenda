import { Hono } from 'hono';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  accountUpdateSchema,
  businessKind,
  DEFAULT_RESERVATION_SETTINGS,
  DEFAULT_TENANT_SETTINGS,
  loginSchema,
  mercadoPagoConnectSchema,
  normalizeMxPhone,
  registerSchema,
  assignableRoles,
  staffCreateSchema,
  tenantUpdateSchema,
  userUpdateSchema,
  type AuthResponse,
  type Role,
  type UserDto,
} from '@agenda/shared';
import { getDb } from '../db/client.js';
import { diningTables, professionals, services, spaces, tenants, users } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { defaultSpaces, RENTAL_SERVICE_NAME } from '../lib/resources.js';
import { DEFAULT_TABLES } from '../lib/tables.js';
import { hashPassword, signToken, slugify, verifyPassword } from '../lib/auth.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { encryptSecret } from '../lib/crypto.js';
import { toTenantDto } from '../lib/mappers.js';
import { getAccount } from '../integrations/mercadopago.js';
import { requireAuth, requireManager, requireOwner, type AppEnv } from '../middleware/auth.js';

export const authRoutes = new Hono<AppEnv>();

/** Team member linked to a login, if any. */
async function linkedProfessional(db: Pick<Db, 'query'>, tenantId: string, userId: string): Promise<string | null> {
  const p = await db.query.professionals.findFirst({
    where: and(eq(professionals.tenantId, tenantId), eq(professionals.userId, userId)),
    columns: { id: true },
  });
  return p?.id ?? null;
}

const sessionUser = async (db: Pick<Db, 'query'>, u: { id: string; name: string; email: string; role: Role; tenantId: string }) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  professionalId: await linkedProfessional(db, u.tenantId, u.id),
});

/** Slugs that collide with public API paths (/api/public/manage/...). */
const RESERVED_SLUGS = new Set(['manage', 'api', 'admin']);

async function uniqueSlug(base: string): Promise<string> {
  const db = getDb();
  const slug = slugify(base) || 'negocio';
  const root = RESERVED_SLUGS.has(slug) ? `${slug}-negocio` : slug;
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
    if (businessKind(input.businessType) === 'reservations') {
      // Restaurants can take online reservations right away.
      await tx.insert(services).values({
        tenantId: tenant!.id,
        name: 'Reservación',
        durationMin: DEFAULT_RESERVATION_SETTINGS.durationMin,
        priceCents: 0,
      });
      await tx.insert(diningTables).values(DEFAULT_TABLES.map((t) => ({ ...t, tenantId: tenant!.id })));
    } else if (businessKind(input.businessType) === 'rentals') {
      // Spaces can be booked right away; the owner sets names and prices.
      await tx.insert(services).values({ tenantId: tenant!.id, name: RENTAL_SERVICE_NAME, durationMin: 60, priceCents: 0 });
      await tx.insert(spaces).values(defaultSpaces(input.businessType).map((x) => ({ ...x, tenantId: tenant!.id })));
    } else if (businessKind(input.businessType) === 'classes') {
      // A first class type so the owner can schedule sessions immediately.
      await tx.insert(services).values({ tenantId: tenant!.id, name: 'Clase grupal', durationMin: 60, priceCents: 0 });
    }
    return { tenant: tenant!, user: user! };
  });

  const token = await signToken({ sub: result.user.id, tid: result.tenant.id, role: 'owner' });
  const body: AuthResponse = {
    token,
    user: { id: result.user.id, name: result.user.name, email: result.user.email, role: 'owner', professionalId: null },
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
    user: await sessionUser(db, user),
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
    user: await sessionUser(db, user),
    tenant: toTenantDto(tenant),
  });
});

/** Own account: name and password. */
authRoutes.patch('/auth/me', requireAuth, async (c) => {
  const input = accountUpdateSchema.parse(await c.req.json());
  const db = getDb();
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, c.get('userId')), eq(users.tenantId, c.get('tenantId'))),
  });
  if (!user) throw new AppError(401, 'unauthorized');
  if (input.newPassword && !(await verifyPassword(input.currentPassword ?? '', user.passwordHash))) {
    throw new AppError(422, 'wrong_password', 'Current password is incorrect');
  }
  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.name) patch.name = input.name;
  if (input.newPassword) patch.passwordHash = await hashPassword(input.newPassword);
  const [updated] = Object.keys(patch).length
    ? await db.update(users).set(patch).where(eq(users.id, user.id)).returning()
    : [user];
  return c.json(await sessionUser(db, updated!));
});

authRoutes.patch('/tenant', requireAuth, requireManager, async (c) => {
  const input = tenantUpdateSchema.parse(await c.req.json());
  const db = getDb();
  // Payment settings are owner-only: admins keep whatever is configured.
  if (c.get('role') !== 'owner' && input.settings) {
    const current = await db.query.tenants.findFirst({ where: eq(tenants.id, c.get('tenantId')) });
    input.settings = { ...input.settings, payments: current?.settings.payments };
  }
  const pay = input.settings?.payments;
  if (pay && (pay.methods.mercadopago || pay.methods.spei)) {
    const current = await db.query.tenants.findFirst({ where: eq(tenants.id, c.get('tenantId')) });
    if (!current?.mpAccessTokenEnc) {
      throw new AppError(422, 'mercadopago_not_connected', 'Connect Mercado Pago first');
    }
  }
  const { profile, ...rest } = input;
  const [tenant] = await db
    .update(tenants)
    .set({
      ...rest,
      ...(profile ?? {}),
      phone: input.phone === undefined ? undefined : input.phone && normalizeMxPhone(input.phone),
    })
    .where(eq(tenants.id, c.get('tenantId')))
    .returning();
  if (!tenant) throw notFound('tenant');
  return c.json(toTenantDto(tenant));
});

/** Connects the business's own Mercado Pago account (money goes directly to them). */
authRoutes.put('/tenant/mercadopago', requireAuth, requireOwner, async (c) => {
  const { accessToken } = mercadoPagoConnectSchema.parse(await c.req.json());
  const account = await getAccount(accessToken);
  const [tenant] = await getDb()
    .update(tenants)
    .set({ mpAccessTokenEnc: encryptSecret(accessToken), mpAccount: account.label })
    .where(eq(tenants.id, c.get('tenantId')))
    .returning();
  if (!tenant) throw notFound('tenant');
  return c.json(toTenantDto(tenant));
});

authRoutes.delete('/tenant/mercadopago', requireAuth, requireOwner, async (c) => {
  const db = getDb();
  const current = await db.query.tenants.findFirst({ where: eq(tenants.id, c.get('tenantId')) });
  if (!current) throw notFound('tenant');
  const payments = current.settings.payments;
  const settings = payments
    ? { ...current.settings, payments: { ...payments, methods: { ...payments.methods, mercadopago: false, spei: false } } }
    : current.settings;
  const [tenant] = await db
    .update(tenants)
    .set({ mpAccessTokenEnc: null, mpAccount: null, settings })
    .where(eq(tenants.id, current.id))
    .returning();
  return c.json(toTenantDto(tenant!));
});

async function listUsers(db: Db, tenantId: string): Promise<UserDto[]> {
  const res = await db.execute<{ id: string; name: string; email: string; role: Role; professional_id: string | null; professional_name: string | null }>(sql`
    select u.id, u.name, u.email, u.role, p.id as professional_id, p.name as professional_name
    from users u left join professionals p on p.user_id = u.id and p.tenant_id = u.tenant_id
    where u.tenant_id = ${tenantId}
    order by case u.role when 'owner' then 0 when 'admin' then 1 else 2 end, u.name`);
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    professionalId: r.professional_id,
    professionalName: r.professional_name,
  }));
}

/** Links a login to a team member (one login per member), or unlinks it with null. */
async function linkProfessional(db: Pick<Db, 'query' | 'update'>, tenantId: string, userId: string, professionalId: string | null) {
  if (professionalId) {
    const p = await db.query.professionals.findFirst({
      where: and(eq(professionals.id, professionalId), eq(professionals.tenantId, tenantId)),
      columns: { id: true },
    });
    if (!p) throw notFound('professional');
  }
  await db
    .update(professionals)
    .set({ userId: null })
    .where(and(eq(professionals.tenantId, tenantId), eq(professionals.userId, userId)));
  if (professionalId) {
    await db
      .update(professionals)
      .set({ userId })
      .where(and(eq(professionals.id, professionalId), eq(professionals.tenantId, tenantId)));
  }
}

/** Owners manage everyone; admins only manage team members ("colaboradores"). */
function assertCanManage(actor: Role, target: Role, nextRole?: Role) {
  const allowed = assignableRoles(actor);
  if (!allowed.includes(target) || (nextRole && !allowed.includes(nextRole))) {
    throw new AppError(403, 'forbidden', 'You cannot manage that role');
  }
}

authRoutes.get('/users', requireAuth, requireManager, async (c) => {
  return c.json(await listUsers(getDb(), c.get('tenantId')));
});

authRoutes.post('/users', requireAuth, requireManager, async (c) => {
  const input = staffCreateSchema.parse(await c.req.json());
  assertCanManage(c.get('role'), input.role);
  const tenantId = c.get('tenantId');
  const db = getDb();
  const existing = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  if (existing) throw conflict('email_taken', 'Email already registered');
  const id = await db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        tenantId,
        email: input.email,
        name: input.name,
        role: input.role,
        passwordHash: await hashPassword(input.password),
      })
      .returning({ id: users.id });
    if (input.professionalId) await linkProfessional(tx, tenantId, user!.id, input.professionalId);
    return user!.id;
  });
  return c.json((await listUsers(db, tenantId)).find((u) => u.id === id), 201);
});

authRoutes.patch('/users/:id', requireAuth, requireManager, async (c) => {
  const input = userUpdateSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const db = getDb();
  const target = await db.query.users.findFirst({ where: and(eq(users.id, id), eq(users.tenantId, tenantId)) });
  if (!target) throw notFound('user');
  const self = id === c.get('userId');
  if (self && input.role && input.role !== target.role) throw new AppError(422, 'own_role', 'You cannot change your own role');
  if (!self) assertCanManage(c.get('role'), target.role, input.role);
  await db.transaction(async (tx) => {
    if (target.role === 'owner' && input.role && input.role !== 'owner') {
      const owners = await tx.select({ id: users.id }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.role, 'owner'), ne(users.id, id)));
      if (!owners.length) throw new AppError(422, 'last_owner', 'The business needs at least one owner');
    }
    const patch: Partial<typeof users.$inferInsert> = {};
    if (input.name) patch.name = input.name;
    if (input.role) patch.role = input.role;
    if (input.password) patch.passwordHash = await hashPassword(input.password);
    if (Object.keys(patch).length) await tx.update(users).set(patch).where(eq(users.id, id));
    if (input.professionalId !== undefined) await linkProfessional(tx, tenantId, id, input.professionalId);
  });
  return c.json((await listUsers(db, tenantId)).find((u) => u.id === id));
});

authRoutes.delete('/users/:id', requireAuth, requireManager, async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  if (id === c.get('userId')) throw new AppError(422, 'own_user', 'You cannot remove yourself');
  const db = getDb();
  const target = await db.query.users.findFirst({ where: and(eq(users.id, id), eq(users.tenantId, tenantId)) });
  if (!target) throw notFound('user');
  assertCanManage(c.get('role'), target.role);
  await db.transaction(async (tx) => {
    await tx.update(professionals).set({ userId: null }).where(and(eq(professionals.tenantId, tenantId), eq(professionals.userId, id)));
    await tx.delete(users).where(and(eq(users.id, id), eq(users.tenantId, tenantId)));
  });
  return c.body(null, 204);
});
