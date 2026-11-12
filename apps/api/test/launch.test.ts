/**
 * Launch hardening: session cookie + CSRF, two-step sign-in, data key rotation, card billing
 * (Mercado Pago faked), read-only mode, export/delete and error monitoring.
 * Needs TEST_DATABASE_URL like api.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withIva, type AuthResponse } from '@agenda/shared';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('launch hardening', () => {
  let app: ReturnType<typeof import('../src/app.js').createApp>;
  let closeDb: () => Promise<void>;
  let owner: AuthResponse;

  const raw = (method: string, path: string, o: { body?: unknown; token?: string; cookie?: string; headers?: Record<string, string> } = {}) =>
    app.request(`/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
        ...(o.cookie ? { cookie: o.cookie } : {}),
        ...(o.headers ?? {}),
      },
      body: o.body ? JSON.stringify(o.body) : undefined,
    });
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await raw(method, path, { body, token });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const reg = (n: string, plan = 'standard', businessName = `Negocio ${n}`) => ({
    businessName,
    businessType: 'barbershop',
    name: `Owner ${n}`,
    email: `owner-${n}@test.mx`,
    password: 'password123',
    plan,
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const { getDb, closeDb: close } = await import('../src/db/client.js');
    const { sql } = await import('drizzle-orm');
    await getDb().execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    app = (await import('../src/app.js')).createApp();
    closeDb = close;
    owner = (await call('POST', '/auth/register', reg('l'))).body;
  });

  afterAll(async () => {
    await closeDb?.();
  });

  it('session cookie: HttpOnly, reads work, writes need X-Requested-With, logout clears it', async () => {
    const res = await raw('POST', '/auth/login', { body: { email: 'owner-l@test.mx', password: 'password123' } });
    expect(res.status).toBe(200);
    const set = res.headers.get('set-cookie') ?? '';
    expect(set).toMatch(/lugali_session=/);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    const cookie = set.split(';')[0]!;
    expect((await raw('GET', '/customers', { cookie })).status).toBe(200);
    // A form on another site can send the cookie but not this header.
    expect((await raw('POST', '/customers', { cookie, body: { name: 'Sin cabecera' } })).status).toBe(403);
    expect((await raw('POST', '/customers', { cookie, body: { name: 'Con cabecera' }, headers: { 'x-requested-with': 'lugali' } })).status).toBe(201);
    // An old saved token moves to the cookie on /auth/me
    const me = await raw('GET', '/auth/me', { token: owner.token });
    expect(me.headers.get('set-cookie') ?? '').toMatch(/lugali_session=/);
    const out = await raw('POST', '/auth/logout');
    expect(out.headers.get('set-cookie') ?? '').toMatch(/lugali_session=;|Max-Age=0/i);
  });

  it('two-step sign-in: setup, login with code, no replay, recovery codes, turn off', async () => {
    const { totpCode, totpStep } = await import('../src/lib/totp.js');
    const s = await call('POST', '/auth/2fa/setup', undefined, owner.token);
    expect(s.status).toBe(200);
    expect(s.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect((await call('POST', '/auth/2fa/enable', { code: '000000' }, owner.token)).status).toBe(422);
    const on = await call('POST', '/auth/2fa/enable', { code: totpCode(s.body.secret) }, owner.token);
    expect(on.status).toBe(200);
    expect(on.body.recoveryCodes).toHaveLength(8);
    expect((await call('GET', '/auth/me', undefined, owner.token)).body.user.twoFactor).toBe(true);

    const login = await call('POST', '/auth/login', { email: 'owner-l@test.mx', password: 'password123' });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBe(true);
    expect(login.body.token).toBeUndefined();
    // The ticket is not a session
    expect((await call('GET', '/customers', undefined, login.body.mfaToken)).status).toBe(401);
    expect((await call('POST', '/auth/login/2fa', { mfaToken: login.body.mfaToken, code: '123456' })).status).toBe(422);
    // The enabling code was spent; the next step's code works once.
    const next = totpCode(s.body.secret, totpStep() + 1);
    const ok = await call('POST', '/auth/login/2fa', { mfaToken: login.body.mfaToken, code: next });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeTruthy();
    expect((await call('POST', '/auth/login/2fa', { mfaToken: login.body.mfaToken, code: next })).status).toBe(422);
    // Recovery code: works once
    const rc = on.body.recoveryCodes[0];
    expect((await call('POST', '/auth/login/2fa', { mfaToken: login.body.mfaToken, code: rc.toUpperCase() })).status).toBe(200);
    expect((await call('POST', '/auth/login/2fa', { mfaToken: login.body.mfaToken, code: rc })).status).toBe(422);
    // Off: password + a code
    expect((await call('POST', '/auth/2fa/disable', { password: 'wrong', code: on.body.recoveryCodes[1] }, owner.token)).status).toBe(422);
    expect((await call('POST', '/auth/2fa/disable', { password: 'password123', code: on.body.recoveryCodes[2] }, owner.token)).status).toBe(200);
    expect((await call('POST', '/auth/login', { email: 'owner-l@test.mx', password: 'password123' })).body.token).toBeTruthy();
  });

  it('demo logins cannot turn on two-step sign-in', async () => {
    const demo = (await call('POST', '/auth/register', reg('d', 'standard', 'Prueba Demo'))).body as AuthResponse;
    expect(demo.tenant.slug).toBe('prueba-demo');
    expect((await call('POST', '/auth/2fa/setup', undefined, demo.token)).status).toBe(403);
    // ...nor be deleted
    expect((await call('POST', '/tenant/delete', { password: 'password123', confirmName: 'Prueba Demo' }, demo.token)).status).toBe(403);
  });

  it('moves data encrypted with the JWT-derived key to DATA_ENCRYPTION_KEY', async () => {
    const { encryptSecret, decryptSecret } = await import('../src/lib/crypto.js');
    const { reencryptAll } = await import('../src/db/reencrypt.js');
    const { getDb } = await import('../src/db/client.js');
    const { sql } = await import('drizzle-orm');
    const legacy = encryptSecret('{"liveKey":"x"}');
    expect(legacy.startsWith('v2:')).toBe(false);
    await getDb().execute(sql`update tenants set invoicing_enc = ${legacy} where id = ${owner.tenant.id}`);
    process.env.DATA_ENCRYPTION_KEY = 'a-separate-data-key-a-separate-data-key';
    try {
      expect(decryptSecret(legacy)).toBe('{"liveKey":"x"}');
      expect(await reencryptAll()).toBeGreaterThanOrEqual(1);
      const row = (await getDb().execute<{ v: string }>(sql`select invoicing_enc as v from tenants where id = ${owner.tenant.id}`)).rows[0]!;
      expect(row.v.startsWith('v2:')).toBe(true);
      expect(decryptSecret(row.v)).toBe('{"liveKey":"x"}');
      // Rotating JWT_SECRET no longer matters for v2 data
      const jwt = process.env.JWT_SECRET;
      process.env.JWT_SECRET = 'another-secret-another-secret-another-1';
      expect(decryptSecret(row.v)).toBe('{"liveKey":"x"}');
      process.env.JWT_SECRET = jwt;
      expect(await reencryptAll()).toBe(0);
    } finally {
      delete process.env.DATA_ENCRYPTION_KEY;
    }
  });

  it('card billing with Stripe: checkout, webhook, plan change, extra location, failed charge, read-only, cancel', async () => {
    const billing = await import('../src/lib/billing.js');
    type Item = { id: string; quantity: number; price: { id: string; unit_amount: number; lookup_key: string } };
    const prices = new Map<string, { id: string; unit_amount: number; lookup_key: string }>();
    const subs = new Map<string, { id: string; status: string; customer: string; metadata: Record<string, string>; items: { data: Item[] } }>();
    const sessions = new Map<string, { id: string; url: string; params: URLSearchParams }>();
    const paid = new Map<string, string>();
    const { sentInTests } = await import('../src/lib/email.js');
    const lastSubject = () => sentInTests[sentInTests.length - 1]?.subject ?? '';
    let n = 0;
    billing.setBillingFetch((async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      const p = new URLSearchParams(String(init?.body ?? ''));
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
      const path = u.pathname.replace('/v1', '');
      if (path === '/prices' && (init?.method ?? 'GET') === 'GET') {
        const key = u.searchParams.get('lookup_keys[]')!;
        const found = [...prices.values()].filter((x) => x.lookup_key === key);
        return json({ data: found });
      }
      if (path === '/prices') {
        const pr = { id: `price_${++n}`, unit_amount: Number(p.get('unit_amount')), lookup_key: p.get('lookup_key')! };
        prices.set(pr.id, pr);
        return json(pr);
      }
      const cm = /^\/checkout\/sessions\/(cs_[^/]+)$/.exec(path);
      if (cm) {
        const se = sessions.get(cm[1]!)!;
        return json({ id: se.id, client_reference_id: se.params.get('client_reference_id'), subscription: paid.get(se.id) ?? null });
      }
      if (path === '/checkout/sessions') {
        const id = `cs_test_${++n}`;
        sessions.set(id, { id, url: `https://checkout.stripe.test/${id}`, params: p });
        return json({ id, url: `https://checkout.stripe.test/${id}` });
      }
      const m = /^\/subscriptions\/(.+)$/.exec(path);
      if (m) {
        const s = subs.get(m[1]!);
        if (!s) return json({ error: { message: 'no such subscription' } }, 404);
        if (init?.method === 'DELETE') s.status = 'canceled';
        if (init?.method === 'POST') {
          for (const i of [0, 1]) {
            const priceId = p.get(`items[${i}][price]`);
            const itemId = p.get(`items[${i}][id]`);
            if (p.get(`items[${i}][deleted]`)) s.items.data = s.items.data.filter((x) => x.id !== itemId);
            else if (priceId) {
              const it = { id: itemId ?? `si_${++n}`, quantity: Number(p.get(`items[${i}][quantity]`) ?? 1), price: prices.get(priceId)! };
              s.items.data = [...s.items.data.filter((x) => x.id !== it.id), it];
            }
          }
          if (p.get('metadata[plan]')) s.metadata.plan = p.get('metadata[plan]')!;
        }
        return json(s);
      }
      if (path === '/billing_portal/sessions') return json({ url: `https://billing.stripe.test/${p.get('customer')}` });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    }) as typeof fetch);
    /** What Stripe does when the checkout is paid: creates the subscription from the session. */
    const pay = (sessionId: string) => {
      const s = sessions.get(sessionId)!;
      const id = `sub_${++n}`;
      const items: Item[] = [0, 1]
        .filter((i) => s.params.get(`line_items[${i}][price]`))
        .map((i) => ({ id: `si_${++n}`, quantity: Number(s.params.get(`line_items[${i}][quantity]`)), price: prices.get(s.params.get(`line_items[${i}][price]`)!)! }));
      paid.set(sessionId, id);
      subs.set(id, { id, status: 'active', customer: 'cus_1', metadata: { tenantId: s.params.get('metadata[tenantId]')!, plan: s.params.get('metadata[plan]')! }, items: { data: items } });
      return id;
    };
    const hook = (type: string, object: Record<string, unknown>) => raw('POST', '/webhooks/billing', { body: { type, data: { object } } });
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    try {
      // Paid sign-up opens on Gratis until the card is in
      const o = (await call('POST', '/auth/register', reg('pay', 'standard'))).body as AuthResponse;
      expect(o.tenant.plan).toBe('free');

      const go = await call('PUT', '/tenant/plan', { plan: 'standard' }, o.token);
      expect(go.status).toBe(200);
      expect(go.body.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.test\/cs_test_/);
      expect(go.body.plan.plan).toBe('free');
      expect(go.body.plan.billing).toMatchObject({ status: 'pending', pendingPlan: 'standard' });
      const cs = go.body.checkoutUrl.split('/').pop();
      expect(sessions.get(cs)!.params.get('mode')).toBe('subscription');
      expect(sessions.get(cs)!.params.get('success_url')).toMatch(/billing=return&session_id=\{CHECKOUT_SESSION_ID\}$/);
      // Not paid yet: the return page confirms nothing
      expect((await call('POST', '/tenant/billing/confirm', { sessionId: cs }, o.token)).body.paid).toBe(false);
      expect([...prices.values()][0]!.unit_amount).toBe(withIva(39_900));

      // Paid in Stripe -> plan on
      const sub = pay(cs);
      expect((await hook('checkout.session.completed', { id: cs, subscription: sub })).status).toBe(200);
      let info = (await call('GET', '/tenant/plan', undefined, o.token)).body;
      expect(info.plan).toBe('standard');
      expect(info.billing).toMatchObject({ status: 'active', pendingPlan: null, amountCents: withIva(39_900) });
      expect(lastSubject()).toMatch(/^Tu plan Estándar está activo/);
      // The return page confirming afterwards doesn't send a second email
      const before = sentInTests.length;
      expect((await call('POST', '/tenant/billing/confirm', { sessionId: cs }, o.token)).body).toMatchObject({ paid: true, plan: { plan: 'standard' } });
      expect(sentInTests.length).toBe(before);

      // Upgrade: same subscription, new price, no new checkout
      const up = await call('PUT', '/tenant/plan', { plan: 'premium' }, o.token);
      expect(up.body.checkoutUrl).toBeNull();
      expect(up.body.plan.plan).toBe('premium');
      expect(subs.get(sub)!.items.data[0]!.price.unit_amount).toBe(withIva(79_900));
      expect(lastSubject()).toMatch(/^Cambiaste al plan Premium/);
      expect(sentInTests[sentInTests.length - 1]!.text).toContain(`$${(withIva(79_900) / 100).toLocaleString('es-MX', { minimumFractionDigits: 2 })} MXN`);

      // Premium includes 2 locations; a third one is added to the subscription
      await call('POST', '/locations', { name: 'Sucursal Dos' }, o.token);
      expect(subs.get(sub)!.items.data).toHaveLength(1);
      const third = await call('POST', '/locations', { name: 'Sucursal Tres' }, o.token);
      expect(third.status).toBe(201);
      const loc = subs.get(sub)!.items.data.find((i) => i.price.lookup_key.startsWith('lugali_extra_location_'));
      expect(loc?.quantity).toBe(1);
      expect(lastSubject()).toMatch(/^Agregaste una sucursal/);

      // Portal to change the card
      expect((await call('POST', '/tenant/billing/portal', undefined, o.token)).body.url).toBe('https://billing.stripe.test/cus_1');

      // A failed charge: grace period, then read-only
      subs.get(sub)!.status = 'past_due';
      await hook('invoice.payment_failed', { id: 'in_1', subscription: sub });
      info = (await call('GET', '/tenant/plan', undefined, o.token)).body;
      expect(info.billing).toMatchObject({ status: 'past_due', readOnly: false });
      expect(lastSubject()).toMatch(/^No pudimos cobrar/);
      expect((await call('POST', '/customers', { name: 'En gracia' }, o.token)).status).toBe(201);
      const { getDb } = await import('../src/db/client.js');
      const { sql } = await import('drizzle-orm');
      await getDb().execute(sql`update tenants set billing_past_due_since = now() - interval '8 days' where id = ${o.tenant.id}`);
      const blocked = await call('POST', '/customers', { name: 'Bloqueado' }, o.token);
      expect(blocked.status).toBe(402);
      expect(blocked.body.error).toBe('billing_read_only');
      expect((await call('GET', '/customers', undefined, o.token)).status).toBe(200);
      // Card updated, Stripe retries and it's paid
      subs.get(sub)!.status = 'active';
      await hook('invoice.paid', { id: 'in_2', parent: { subscription_details: { subscription: sub } } });
      expect((await call('POST', '/customers', { name: 'Ya pagó' }, o.token)).status).toBe(201);

      // An extra business opened with billing on is read-only until paid
      const extra = await call('POST', '/businesses', { businessName: 'Negocio Dos', businessType: 'barbershop' }, o.token);
      expect(extra.status).toBe(201);
      expect((await call('POST', '/customers', { name: 'X' }, extra.body.token)).status).toBe(402);
      const pay2 = await call('PUT', '/tenant/plan', { plan: 'standard' }, extra.body.token);
      const cs2 = pay2.body.checkoutUrl.split('/').pop();
      expect(prices.get(sessions.get(cs2)!.params.get('line_items[0][price]')!)!.lookup_key).toMatch(/^lugali_extra_business_/);
      pay(cs2);
      // Another business can't confirm this payment; its own owner can, right on return
      expect((await call('POST', '/tenant/billing/confirm', { sessionId: cs2 }, o.token)).status).toBe(403);
      expect((await call('POST', '/tenant/billing/confirm', { sessionId: cs2 }, extra.body.token)).body.paid).toBe(true);
      expect(lastSubject()).toMatch(/^Tu negocio adicional está activo · Negocio Dos/);
      expect((await call('POST', '/customers', { name: 'Y' }, extra.body.token)).status).toBe(201);

      // Bad signature is rejected once the secret is set
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
      expect((await hook('customer.subscription.updated', { id: sub })).status).toBe(400);
      delete process.env.STRIPE_WEBHOOK_SECRET;

      // Cancelled in Stripe -> back to Gratis
      subs.get(sub)!.status = 'canceled';
      await hook('customer.subscription.deleted', { id: sub });
      info = (await call('GET', '/tenant/plan', undefined, o.token)).body;
      expect(info.plan).toBe('free');
      expect(info.billing.status).toBe('cancelled');
      expect(lastSubject()).toMatch(/^Tu suscripción se canceló/);

      expect(await billing.reconcileBilling(getDb())).toBeGreaterThanOrEqual(1);
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
      billing.setBillingFetch(null);
    }
  });

  it('verifies Stripe webhook signatures', async () => {
    const { verifyStripeSignature } = await import('../src/lib/billing.js');
    const crypto = await import('node:crypto');
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_abc';
    try {
      const body = '{"type":"x"}';
      const t = Math.floor(Date.now() / 1000);
      const v1 = crypto.createHmac('sha256', 'whsec_abc').update(`${t}.${body}`).digest('hex');
      expect(verifyStripeSignature(body, `t=${t},v1=${v1}`)).toBe(true);
      expect(verifyStripeSignature(body + ' ', `t=${t},v1=${v1}`)).toBe(false);
      expect(verifyStripeSignature(body, `t=${t - 1000},v1=${v1}`)).toBe(false);
    } finally {
      delete process.env.STRIPE_WEBHOOK_SECRET;
    }
  });

  it('owner exports everything (no secrets) and deletes the business', async () => {
    const o = (await call('POST', '/auth/register', reg('del'))).body as AuthResponse;
    await call('POST', '/customers', { name: 'Cliente Export' }, o.token);
    const res = await raw('GET', '/tenant/export', { token: o.token });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="lugali-negocio-del-/);
    const data = (await res.json()) as { tenant: Record<string, unknown>; data: Record<string, Array<Record<string, unknown>>> };
    expect(data.data.customers!.some((c) => c.name === 'Cliente Export')).toBe(true);
    expect(data.tenant).not.toHaveProperty('invoicing_enc');
    expect(data.tenant).not.toHaveProperty('mp_access_token_enc');

    expect((await call('POST', '/tenant/delete', { password: 'password123', confirmName: 'Otro nombre' }, o.token)).status).toBe(422);
    const del = await call('POST', '/tenant/delete', { password: 'password123', confirmName: 'negocio DEL' }, o.token);
    expect(del.status).toBe(200);
    expect(del.body.otherBusinesses).toBe(0);
    // The login had no other business, so it's gone too
    expect((await call('POST', '/auth/login', { email: 'owner-del@test.mx', password: 'password123' })).status).toBe(401);
    expect((await call('GET', '/public/negocio-del')).status).toBe(404);
  });

  it('records unexpected errors and emails the first one', async () => {
    process.env.TEST_MONITOR = '1';
    process.env.ALERT_EMAIL = 'alertas@test.mx';
    try {
      const { recordError } = await import('../src/lib/monitor.js');
      const { sentInTests } = await import('../src/lib/email.js');
      const before = sentInTests.length;
      await recordError({ source: 'api', message: 'GET boom 123', stack: 'Error: boom\n    at x (file.ts:1:2)', path: '/api/x' });
      await recordError({ source: 'api', message: 'GET boom 456', stack: 'Error: boom\n    at x (file.ts:9:9)', path: '/api/x' });
      const alerts = sentInTests.slice(before).filter((m) => m.to === 'alertas@test.mx');
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.subject).toMatch(/Error nuevo/);
      const { getDb } = await import('../src/db/client.js');
      const { sql } = await import('drizzle-orm');
      const rows = (await getDb().execute<{ count: number }>(sql`select count from error_events where source = 'api'`)).rows;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.count)).toBe(2);
      // Browser reports go through the public endpoint; extension noise is dropped
      expect((await raw('POST', '/client-errors', { body: { message: 'TypeError: x is undefined', stack: 'at y (app.js:1:1)', path: '/agenda' } })).status).toBe(204);
      await raw('POST', '/client-errors', { body: { message: 'ResizeObserver loop limit exceeded' } });
      const web = (await getDb().execute(sql`select message from error_events where source = 'web'`)).rows;
      expect(web).toHaveLength(1);
    } finally {
      delete process.env.TEST_MONITOR;
      delete process.env.ALERT_EMAIL;
    }
  });
});
