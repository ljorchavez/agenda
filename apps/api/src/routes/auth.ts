import { randomBytes } from 'node:crypto';
import { googleClientId, verifyGoogleCredential } from '../lib/google.js';
import { Hono, type Context } from 'hono';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  accountUpdateSchema,
  businessCreateSchema,
  businessKind,
  switchBusinessSchema,
  type BusinessSummary,
  type BusinessType,
  DEFAULT_RESERVATION_SETTINGS,
  DEFAULT_TENANT_SETTINGS,
  loginSchema,
  mercadoPagoConnectSchema,
  normalizeMxPhone,
  PLAN_LIMITS,
  planChangeSchema,
  registerSchema,
  googleLoginSchema,
  type PublicConfigDto,
  SELECTABLE_PLANS,
  type PlanId,
  assignableRoles,
  staffCreateSchema,
  tenantUpdateSchema,
  userUpdateSchema,
  type AuthResponse,
  type Role,
  type UserDto,
} from '@agenda/shared';
import { getDb } from '../db/client.js';
import { assertNotLimited, clearAttempts, clientIp, loginLimits, recordAttempt } from '../lib/throttle.js';
import { memberships, resources, services, tenants, users, type Tenant, type User } from '../db/schema.js';
import type { Db } from '../db/client.js';
import { starterResources } from '../lib/resources.js';
import { hashPassword, signToken, slugify, verifyPassword } from '../lib/auth.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { encryptSecret } from '../lib/crypto.js';
import { toTenantDto } from '../lib/mappers.js';
import { getAccount } from '../integrations/mercadopago.js';
import { requireAuth, requireBusinessManager, requireManager, requireOwner, type AppEnv } from '../middleware/auth.js';
import { resolveLocation } from '../lib/locations.js';
import { assertCanAddBusiness, assertFitsPlan, planInfo } from '../lib/plan.js';
import { billingProvider } from '../lib/billing.js';

export const authRoutes = new Hono<AppEnv>();

/** Resource (team member) linked to a login, if any. */
async function linkedResource(db: Pick<Db, 'query'>, tenantId: string, userId: string): Promise<string | null> {
  const r = await db.query.resources.findFirst({
    where: and(eq(resources.tenantId, tenantId), eq(resources.userId, userId)),
    columns: { id: true },
  });
  return r?.id ?? null;
}

async function sessionUser(db: Pick<Db, 'query'>, u: Pick<User, 'id' | 'name' | 'email'> & { professional?: User['professional'] }, tenantId: string) {
  const m = await db.query.memberships.findFirst({
    where: and(eq(memberships.tenantId, tenantId), eq(memberships.userId, u.id)),
    columns: { role: true, locationId: true },
  });
  if (!m) throw new AppError(401, 'unauthorized', 'No access to this business');
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    role: m.role,
    resourceId: await linkedResource(db, tenantId, u.id),
    locationId: m.role === 'owner' ? null : m.locationId,
    professional: u.professional ?? null,
  };
}

/** Businesses this person can open, most recently used first. */
async function businessesFor(db: Db, userId: string): Promise<BusinessSummary[]> {
  const res = await db.execute<{ id: string; name: string; slug: string; business_type: BusinessType; role: Role }>(sql`
    select t.id, t.name, t.slug, t.business_type, m.role
    from memberships m join tenants t on t.id = m.tenant_id
    where m.user_id = ${userId}
    order by m.last_used_at desc nulls last, t.name`);
  return res.rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, businessType: r.business_type, kind: businessKind(r.business_type), role: r.role }));
}

/** Token + profile for one business; remembers it as the last one used. */
async function issueSession(db: Db, user: Pick<User, 'id' | 'name' | 'email'>, tenantId: string): Promise<AuthResponse> {
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!tenant) throw notFound('tenant');
  const su = await sessionUser(db, user, tenantId);
  await db
    .update(memberships)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, user.id)));
  const token = await signToken({ sub: user.id, tid: tenant.id, role: su.role });
  return { token, user: su, tenant: toTenantDto(tenant), businesses: await businessesFor(db, user.id) };
}

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

/** Creates a business with the starter resources for its kind. Its primary location is created by a DB trigger. */
async function createBusiness(
  tx: Pick<Db, 'insert'>,
  input: { businessName: string; businessType: BusinessType; phone?: string; locale?: 'es' | 'en'; plan: PlanId },
): Promise<Tenant> {
  const slug = await uniqueSlug(input.businessName);
  const [tenant] = await tx
    .insert(tenants)
    .values({
      name: input.businessName,
      slug,
      businessType: input.businessType,
      phone: input.phone ? normalizeMxPhone(input.phone) : null,
      locale: input.locale ?? 'es',
      settings: DEFAULT_TENANT_SETTINGS,
      plan: input.plan,
    })
    .returning();
  const kind = businessKind(input.businessType);
  if (kind === 'reservations') {
    // Restaurants can take online reservations right away.
    await tx.insert(services).values({
      tenantId: tenant!.id,
      name: 'Reservación',
      durationMin: DEFAULT_RESERVATION_SETTINGS.durationMin,
      priceCents: 0,
    });
  } else if (kind === 'rentals') {
    // Spaces can be booked right away; the owner sets names and prices.
    await tx.insert(services).values({ tenantId: tenant!.id, name: 'Renta de espacio', durationMin: 60, priceCents: 0 });
  } else if (kind === 'classes') {
    // A first class type so the owner can schedule sessions immediately.
    await tx.insert(services).values({ tenantId: tenant!.id, name: 'Clase grupal', durationMin: 60, priceCents: 0 });
  }
  // Tables or spaces so online booking works right away.
  const starter = starterResources(kind, input.businessType);
  if (starter.length) await tx.insert(resources).values(starter.map((r) => ({ ...r, tenantId: tenant!.id })));
  return tenant!;
}

authRoutes.post('/auth/register', async (c) => {
  const input = registerSchema.parse(await c.req.json());
  const db = getDb();
  // With Google the verified Google email is the login; a random password is kept (reset works).
  if (input.googleCredential) input.email = (await verifyGoogleCredential(input.googleCredential)).email;
  else if (!input.password) throw new AppError(422, 'validation_error', 'Password required');

  const existing = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  if (existing) throw conflict('email_taken', 'Email already registered');

  const passwordHash = await hashPassword(input.password ?? randomBytes(24).toString('base64url'));
  const result = await db.transaction(async (tx) => {
    const tenant = await createBusiness(tx, input);
    const [user] = await tx.insert(users).values({ email: input.email, passwordHash, name: input.name }).returning();
    await tx.insert(memberships).values({ tenantId: tenant.id, userId: user!.id, role: 'owner' });
    return { tenant, user: user! };
  });
  return c.json(await issueSession(db, result.user, result.tenant.id), 201);
});

authRoutes.post('/auth/login', async (c) => {
  const input = loginSchema.parse(await c.req.json());
  const db = getDb();
  const limits = loginLimits(clientIp(c), input.email);
  await assertNotLimited(db, limits);
  const user = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  // Same error for unknown email and wrong password to avoid account enumeration.
  if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
    await recordAttempt(db, limits);
    throw new AppError(401, 'invalid_credentials', 'Invalid email or password');
  }
  await clearAttempts(db, [limits[0]!.key]);
  const [last] = await businessesFor(db, user.id);
  if (!last) throw new AppError(401, 'no_business', 'This login has no business');
  return c.json(await issueSession(db, user, last.id));
});

/** Settings the app needs before login (no secrets). */
authRoutes.get('/config', (c) => c.json({ googleClientId: googleClientId() } satisfies PublicConfigDto));

/** "Continuar con Google" for an existing account (same email). New people go to sign-up. */
authRoutes.post('/auth/google', async (c) => {
  const { credential } = googleLoginSchema.parse(await c.req.json());
  const db = getDb();
  const g = await verifyGoogleCredential(credential);
  const user = await db.query.users.findFirst({ where: eq(users.email, g.email) });
  if (!user) throw new AppError(404, 'google_no_account', 'No account with this Google email yet', { email: g.email, name: g.name });
  const [last] = await businessesFor(db, user.id);
  if (!last) throw new AppError(401, 'no_business', 'This login has no business');
  return c.json(await issueSession(db, user, last.id));
});

// ---------- Authenticated ----------

authRoutes.get('/auth/me', requireAuth, async (c) => {
  const db = getDb();
  const user = await db.query.users.findFirst({ where: eq(users.id, c.get('userId')) });
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, c.get('tenantId')) });
  if (!user || !tenant) throw new AppError(401, 'unauthorized');
  return c.json({
    user: await sessionUser(db, user, tenant.id),
    tenant: toTenantDto(tenant),
    businesses: await businessesFor(db, user.id),
  });
});

/** Opens another business this person belongs to (new token). */
authRoutes.post('/auth/switch', requireAuth, async (c) => {
  const { tenantId } = switchBusinessSchema.parse(await c.req.json());
  const db = getDb();
  const user = await db.query.users.findFirst({ where: eq(users.id, c.get('userId')) });
  if (!user) throw new AppError(401, 'unauthorized');
  const m = await db.query.memberships.findFirst({
    where: and(eq(memberships.userId, user.id), eq(memberships.tenantId, tenantId)),
    columns: { id: true },
  });
  if (!m) throw notFound('business');
  return c.json(await issueSession(db, user, tenantId));
});

/** Anyone signed in can open another business of their own (they become its owner). */
authRoutes.post('/businesses', requireAuth, async (c) => {
  const input = businessCreateSchema.parse(await c.req.json());
  const db = getDb();
  const user = await db.query.users.findFirst({ where: eq(users.id, c.get('userId')) });
  if (!user) throw new AppError(401, 'unauthorized');
  // A free business can't have siblings; additional businesses start on Estándar (billed as an add-on).
  await assertCanAddBusiness(db, user.id);
  const tenant = await db.transaction(async (tx) => {
    const t = await createBusiness(tx, { ...input, plan: 'standard' });
    await tx.insert(memberships).values({ tenantId: t.id, userId: user.id, role: 'owner' });
    return t;
  });
  return c.json(await issueSession(db, user, tenant.id), 201);
});

/** Own account: name and password. */
authRoutes.patch('/auth/me', requireAuth, async (c) => {
  const input = accountUpdateSchema.parse(await c.req.json());
  const db = getDb();
  const user = await db.query.users.findFirst({ where: eq(users.id, c.get('userId')) });
  if (!user) throw new AppError(401, 'unauthorized');
  if (input.newPassword && !(await verifyPassword(input.currentPassword ?? '', user.passwordHash))) {
    throw new AppError(422, 'wrong_password', 'Current password is incorrect');
  }
  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.name) patch.name = input.name;
  if (input.newPassword) patch.passwordHash = await hashPassword(input.newPassword);
  if (input.professional) {
    const p = input.professional;
    patch.professional = { license: p.license || null, institution: p.institution || null, specialty: p.specialty || null, specialtyLicense: p.specialtyLicense || null };
  }
  const [updated] = Object.keys(patch).length
    ? await db.update(users).set(patch).where(eq(users.id, user.id)).returning()
    : [user];
  return c.json(await sessionUser(db, updated!, c.get('tenantId')));
});

// ---------- Subscription plan ----------

authRoutes.get('/tenant/plan', requireAuth, requireBusinessManager, async (c) => {
  return c.json(await planInfo(getDb(), c.get('tenantId'), billingProvider() !== null));
});

/**
 * Owner changes the plan. With card billing connected this returns a checkout page and the plan
 * changes when the payment is confirmed; until then it applies right away without a charge.
 */
authRoutes.put('/tenant/plan', requireAuth, requireOwner, async (c) => {
  const { plan } = planChangeSchema.parse(await c.req.json());
  if (!SELECTABLE_PLANS.includes(plan)) throw new AppError(422, 'plan_unavailable', 'This plan is not available yet');
  const db = getDb();
  const tenantId = c.get('tenantId');
  await assertFitsPlan(db, tenantId, plan);
  if (!PLAN_LIMITS[plan].extraBusinesses) {
    const owned = await db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, c.get('userId')), eq(memberships.role, 'owner')));
    if (owned.length > 1) throw new AppError(402, 'plan_limit_businesses', 'The free plan includes one business');
  }
  const billing = billingProvider();
  if (billing && plan !== 'free') {
    const user = await db.query.users.findFirst({ where: eq(users.id, c.get('userId')) });
    const info = await planInfo(db, tenantId, true);
    const returnUrl = `${new URL(c.req.url).origin}/settings#plan`;
    const url = await billing.checkoutUrl({ tenantId, plan, extraLocations: info.extraLocations, extraBusiness: info.extraBusiness, email: user!.email, returnUrl });
    return c.json({ checkoutUrl: url, plan: info });
  }
  await db.update(tenants).set({ plan }).where(eq(tenants.id, tenantId));
  return c.json({ checkoutUrl: null, plan: await planInfo(db, tenantId, billing !== null) });
});

authRoutes.patch('/tenant', requireAuth, requireBusinessManager, async (c) => {
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

async function listUsers(db: Db, tenantId: string, locationId: string | null = null): Promise<UserDto[]> {
  const loc = locationId ? sql`and m.location_id = ${locationId}` : sql``;
  const res = await db.execute<{
    id: string; name: string; email: string; role: Role; resource_id: string | null; resource_name: string | null;
    location_id: string | null; location_name: string | null; shared: boolean;
  }>(sql`
    select u.id, u.name, u.email, m.role, r.id as resource_id, r.name as resource_name,
           m.location_id, l.name as location_name,
           exists (select 1 from memberships o where o.user_id = u.id and o.tenant_id <> m.tenant_id) as shared
    from memberships m
    join users u on u.id = m.user_id
    left join resources r on r.user_id = u.id and r.tenant_id = m.tenant_id
    left join locations l on l.id = m.location_id and l.tenant_id = m.tenant_id
    where m.tenant_id = ${tenantId} ${loc}
    order by case m.role when 'owner' then 0 when 'admin' then 1 else 2 end, u.name`);
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    resourceId: r.resource_id,
    resourceName: r.resource_name,
    locationId: r.role === 'owner' ? null : r.location_id,
    locationName: r.role === 'owner' ? null : r.location_name,
    sharedAccount: r.shared,
  }));
}

/** Links a login to a resource (one login per resource), or unlinks it with null. */
async function linkResource(db: Pick<Db, 'query' | 'update'>, tenantId: string, userId: string, resourceId: string | null) {
  if (resourceId) {
    const r = await db.query.resources.findFirst({
      where: and(eq(resources.id, resourceId), eq(resources.tenantId, tenantId)),
      columns: { id: true },
    });
    if (!r) throw notFound('resource');
  }
  await db.update(resources).set({ userId: null }).where(and(eq(resources.tenantId, tenantId), eq(resources.userId, userId)));
  if (resourceId) {
    await db.update(resources).set({ userId }).where(and(eq(resources.id, resourceId), eq(resources.tenantId, tenantId)));
  }
}

/** Owners manage everyone; admins only manage team members ("colaboradores"). */
function assertCanManage(actor: Role, target: Role, nextRole?: Role) {
  const allowed = assignableRoles(actor);
  if (!allowed.includes(target) || (nextRole && !allowed.includes(nextRole))) {
    throw new AppError(403, 'forbidden', 'You cannot manage that role');
  }
}

/**
 * Location a login gets: managers limited to one location (gerentes) can only add people to it.
 * `undefined` = leave unchanged.
 */
async function locationForMember(db: Db, c: Context<AppEnv>, requested: string | null | undefined): Promise<string | null | undefined> {
  const own = c.get('role') === 'owner' ? null : c.get('locationId');
  if (own) {
    if (requested && requested !== own) throw new AppError(403, 'forbidden', 'You can only manage your location');
    return own;
  }
  if (requested === undefined || requested === null) return requested;
  return (await resolveLocation(db, c.get('tenantId'), requested)).id;
}

async function membershipOf(db: Db, tenantId: string, userId: string) {
  return db.query.memberships.findFirst({ where: and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)) });
}

/** Gerentes de sucursal only see and manage the logins of their location. */
function assertSameLocation(c: Context<AppEnv>, target: { locationId: string | null }) {
  const own = c.get('role') === 'owner' ? null : c.get('locationId');
  if (own && target.locationId !== own) throw notFound('user');
}

authRoutes.get('/users', requireAuth, requireManager, async (c) => {
  const own = c.get('role') === 'owner' ? null : c.get('locationId');
  return c.json(await listUsers(getDb(), c.get('tenantId'), own));
});

/**
 * Adds a login. If the email already has an account (e.g. someone who works in two businesses),
 * they just get access here with their existing password.
 */
authRoutes.post('/users', requireAuth, requireManager, async (c) => {
  const input = staffCreateSchema.parse(await c.req.json());
  assertCanManage(c.get('role'), input.role);
  const tenantId = c.get('tenantId');
  const db = getDb();
  const locationId = input.role === 'owner' ? null : ((await locationForMember(db, c, input.locationId)) ?? null);
  const existing = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  if (existing && (await membershipOf(db, tenantId, existing.id))) throw conflict('email_taken', 'That person already has access');
  const id = await db.transaction(async (tx) => {
    const userId = existing
      ? existing.id
      : (await tx
          .insert(users)
          .values({ email: input.email, name: input.name, passwordHash: await hashPassword(input.password) })
          .returning({ id: users.id }))[0]!.id;
    await tx.insert(memberships).values({ tenantId, userId, role: input.role, locationId });
    if (input.resourceId) await linkResource(tx, tenantId, userId, input.resourceId);
    return userId;
  });
  return c.json((await listUsers(db, tenantId)).find((u) => u.id === id), 201);
});

authRoutes.patch('/users/:id', requireAuth, requireManager, async (c) => {
  const input = userUpdateSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  const db = getDb();
  const target = await membershipOf(db, tenantId, id);
  if (!target) throw notFound('user');
  const self = id === c.get('userId');
  if (!self) assertSameLocation(c, target);
  if (self && input.role && input.role !== target.role) throw new AppError(422, 'own_role', 'You cannot change your own role');
  if (!self) assertCanManage(c.get('role'), target.role, input.role);
  const shared = (await listUsers(db, tenantId)).find((u) => u.id === id)?.sharedAccount;
  // Someone who also works elsewhere manages their own name and password.
  if (shared && !self && (input.name || input.password)) {
    throw new AppError(422, 'shared_account', 'This person also uses other businesses; only they can change their name or password');
  }
  const locationId = self ? undefined : await locationForMember(db, c, input.locationId);
  await db.transaction(async (tx) => {
    const nextRole = input.role ?? target.role;
    if (target.role === 'owner' && nextRole !== 'owner') {
      const owners = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, 'owner'), ne(memberships.userId, id)));
      if (!owners.length) throw new AppError(422, 'last_owner', 'The business needs at least one owner');
    }
    const patch: Partial<typeof users.$inferInsert> = {};
    if (input.name) patch.name = input.name;
    if (input.password) {
      patch.passwordHash = await hashPassword(input.password);
      patch.passwordChangedAt = new Date(); // signs that person out everywhere
    }
    if (Object.keys(patch).length) await tx.update(users).set(patch).where(eq(users.id, id));
    const mPatch: Partial<typeof memberships.$inferInsert> = {};
    if (input.role) mPatch.role = input.role;
    if (locationId !== undefined) mPatch.locationId = locationId;
    if (nextRole === 'owner') mPatch.locationId = null;
    if (Object.keys(mPatch).length) await tx.update(memberships).set(mPatch).where(eq(memberships.id, target.id));
    if (input.resourceId !== undefined) await linkResource(tx, tenantId, id, input.resourceId);
  });
  return c.json((await listUsers(db, tenantId)).find((u) => u.id === id));
});

/** Removes access to this business; the account itself is deleted when it has no other business. */
authRoutes.delete('/users/:id', requireAuth, requireManager, async (c) => {
  const tenantId = c.get('tenantId');
  const id = c.req.param('id');
  if (id === c.get('userId')) throw new AppError(422, 'own_user', 'You cannot remove yourself');
  const db = getDb();
  const target = await membershipOf(db, tenantId, id);
  if (!target) throw notFound('user');
  assertSameLocation(c, target);
  assertCanManage(c.get('role'), target.role);
  await db.transaction(async (tx) => {
    if (target.role === 'owner') {
      const owners = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, 'owner'), ne(memberships.userId, id)));
      if (!owners.length) throw new AppError(422, 'last_owner', 'The business needs at least one owner');
    }
    await tx.update(resources).set({ userId: null }).where(and(eq(resources.tenantId, tenantId), eq(resources.userId, id)));
    await tx.delete(memberships).where(eq(memberships.id, target.id));
    const others = await tx.select({ id: memberships.id }).from(memberships).where(eq(memberships.userId, id)).limit(1);
    if (!others.length) await tx.delete(users).where(eq(users.id, id));
  });
  return c.body(null, 204);
});
