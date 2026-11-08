/**
 * Integration tests against a real PostgreSQL. Skipped unless TEST_DATABASE_URL is set:
 *   TEST_DATABASE_URL=postgres://agenda:agenda@localhost:5432/agenda_test pnpm --filter @agenda/api test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import type { AuthResponse, CustomerWithStats, DashboardDto } from '@agenda/shared';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('API (integration)', () => {
  let app: ReturnType<typeof import('../src/app.js').createApp>;
  let closeDb: () => Promise<void>;
  let a: AuthResponse;
  let b: AuthResponse;

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await app.request(`/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const { getDb, closeDb: close } = await import('../src/db/client.js');
    const { sql } = await import('drizzle-orm');
    await getDb().execute(sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;`);
    const { runMigrations } = await import('../src/db/migrate.js');
    await runMigrations();
    app = (await import('../src/app.js')).createApp();
    closeDb = close;

    const reg = (n: string) => ({
      businessName: `Negocio ${n}`,
      businessType: 'barbershop',
      name: `Owner ${n}`,
      email: `owner-${n}@test.mx`,
      password: 'password123',
    });
    a = (await call('POST', '/auth/register', reg('a'))).body;
    b = (await call('POST', '/auth/register', reg('b'))).body;
  });

  afterAll(async () => {
    await closeDb?.();
  });

  it('registers and logs in', async () => {
    expect(a.token).toBeTruthy();
    expect(a.tenant.slug).toBe('negocio-a');
    const login = await call('POST', '/auth/login', { email: 'owner-a@test.mx', password: 'password123' });
    expect(login.status).toBe(200);
    const bad = await call('POST', '/auth/login', { email: 'owner-a@test.mx', password: 'nope' });
    expect(bad.status).toBe(401);
  });

  it('requires auth on private routes', async () => {
    expect((await call('GET', '/customers')).status).toBe(401);
  });

  it('full flow: service -> customer -> appointment -> complete with payment -> stats', async () => {
    const svc = await call('POST', '/services', { name: 'Corte', durationMin: 30, priceCents: 20000 }, a.token);
    expect(svc.status).toBe(201);
    const cust = await call('POST', '/customers', { name: 'Juan Pérez', phone: '55 1111 2222' }, a.token);
    expect(cust.status).toBe(201);
    expect(cust.body.phone).toBe('+525511112222');

    const start = DateTime.now().minus({ days: 3 }).set({ hour: 10, minute: 0, second: 0, millisecond: 0 });
    const appt = await call(
      'POST',
      '/appointments',
      { customerId: cust.body.id, serviceId: svc.body.id, startsAt: start.toISO() },
      a.token,
    );
    expect(appt.status).toBe(201);

    // Double booking is rejected
    const overlap = await call(
      'POST',
      '/appointments',
      { customerId: cust.body.id, serviceId: svc.body.id, startsAt: start.plus({ minutes: 15 }).toISO() },
      a.token,
    );
    expect(overlap.status).toBe(409);

    const done = await call('PATCH', `/appointments/${appt.body.id}`, { status: 'completed', paymentMethod: 'cash' }, a.token);
    expect(done.status).toBe(200);
    expect(done.body.paidCents).toBe(20000);

    const list = await call('GET', '/customers', undefined, a.token);
    const juan = (list.body.items as CustomerWithStats[]).find((c) => c.name === 'Juan Pérez')!;
    expect(juan.visits).toBe(1);
    expect(juan.totalSpentCents).toBe(20000);

    const dash = await call('GET', '/metrics/dashboard', undefined, a.token);
    expect(dash.status).toBe(200);
    expect((dash.body as DashboardDto).revenueByMonth.length).toBeGreaterThan(0);
  });

  it('isolates tenants: B cannot see or modify A data', async () => {
    const aCustomers = await call('GET', '/customers', undefined, a.token);
    const target = aCustomers.body.items[0];
    expect(target).toBeTruthy();

    const bList = await call('GET', '/customers', undefined, b.token);
    expect(bList.body.items).toHaveLength(0);
    expect((await call('GET', `/customers/${target.id}`, undefined, b.token)).status).toBe(404);
    expect((await call('PUT', `/customers/${target.id}`, { name: 'hacked' }, b.token)).status).toBe(404);
    expect((await call('DELETE', `/customers/${target.id}`, undefined, b.token)).status).toBe(404);

    // B can't book A's customer into B's agenda either
    const bSvc = await call('POST', '/services', { name: 'X', durationMin: 30, priceCents: 0 }, b.token);
    const cross = await call(
      'POST',
      '/appointments',
      { customerId: target.id, serviceId: bSvc.body.id, startsAt: new Date().toISOString() },
      b.token,
    );
    expect(cross.status).toBe(404);
  });

  it('public booking: availability and booking', async () => {
    const pub = await call('GET', '/public/negocio-a');
    expect(pub.status).toBe(200);
    const serviceId = pub.body.services[0].id;

    // Find the next open weekday
    let day = DateTime.now().setZone('America/Mexico_City').plus({ days: 1 });
    while (day.weekday === 7) day = day.plus({ days: 1 });
    const avail = await call('GET', `/public/negocio-a/availability?serviceId=${serviceId}&date=${day.toISODate()}`);
    expect(avail.body.slots.length).toBeGreaterThan(0);
    const slot = avail.body.slots[0];

    const booking = await call('POST', '/public/negocio-a/bookings', {
      serviceId,
      startsAt: slot,
      name: 'Cliente Web',
      phone: '5533334444',
    });
    expect(booking.status).toBe(201);

    // Same slot can't be booked twice
    const again = await call('POST', '/public/negocio-a/bookings', {
      serviceId,
      startsAt: slot,
      name: 'Otra Persona',
      phone: '5555556666',
    });
    expect(again.status).toBe(409);
  });

  it('reminders: sends (dry run) once for appointments in the window', async () => {
    const { sendDueReminders } = await import('../src/jobs/reminders.js');
    const cust = await call('POST', '/customers', { name: 'Recordar', phone: '5577778888' }, a.token);
    const svc = await call('GET', '/services', undefined, a.token);
    await call(
      'POST',
      '/appointments',
      {
        customerId: cust.body.id,
        serviceId: svc.body[0].id,
        startsAt: DateTime.now().plus({ hours: 5 }).toISO(),
        allowOverlap: true,
      },
      a.token,
    );
    const first = await sendDueReminders();
    expect(first.processed).toBeGreaterThanOrEqual(1);
    const second = await sendDueReminders();
    expect(second.processed).toBe(0);
  });

  it('payment settings: defaults, validation, deposit on public booking', async () => {
    const me = await call('GET', '/auth/me', undefined, a.token);
    expect(me.body.tenant.settings.payments.deposit.enabled).toBe(false);
    expect(me.body.tenant.mercadoPago).toEqual({ connected: false, account: null });
    const base = me.body.tenant.settings;

    // invalid CLABE rejected
    let r = await call('PATCH', '/tenant', { settings: { ...base, payments: { ...base.payments, transfer: { bank: 'X', accountHolder: 'Y', clabe: '012180001234567890' } } } }, a.token);
    expect(r.status).toBe(422);
    // percent > 100 rejected
    r = await call('PATCH', '/tenant', { settings: { ...base, payments: { ...base.payments, deposit: { enabled: true, type: 'percent', value: 150 } } } }, a.token);
    expect(r.status).toBe(422);
    // online methods need Mercado Pago connected
    r = await call('PATCH', '/tenant', { settings: { ...base, payments: { ...base.payments, methods: { ...base.payments.methods, mercadopago: true } } } }, a.token);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('mercadopago_not_connected');
    // staff (non-owner) cannot change settings
    await call('POST', '/users', { name: 'Staff', email: 'staff-a@test.mx', password: 'password123' }, a.token);
    const staff = await call('POST', '/auth/login', { email: 'staff-a@test.mx', password: 'password123' });
    r = await call('PATCH', '/tenant', { settings: base }, staff.body.token);
    expect(r.status).toBe(403);

    // enable 40% deposit with transfer details
    r = await call('PATCH', '/tenant', { settings: { ...base, payments: { ...base.payments, transfer: { bank: 'BBVA', accountHolder: 'Negocio A', clabe: '012180001234567899' }, deposit: { enabled: true, type: 'percent', value: 40 } } } }, a.token);
    expect(r.status).toBe(200);
    expect(r.body.settings.payments.deposit.value).toBe(40);

    const pub = await call('GET', '/public/negocio-a');
    expect(pub.body.deposit).toEqual({ type: 'percent', value: 40 });
    const svc = pub.body.services[0];
    let day = DateTime.now().setZone('America/Mexico_City').plus({ days: 3 });
    while (day.weekday === 7) day = day.plus({ days: 1 });
    const avail = await call('GET', `/public/negocio-a/availability?serviceId=${svc.id}&date=${day.toISODate()}`);
    const booking = await call('POST', '/public/negocio-a/bookings', { serviceId: svc.id, startsAt: avail.body.slots[2], name: 'Con Anticipo', phone: '5512121212' });
    expect(booking.status).toBe(201);
    expect(booking.body.deposit.amountCents).toBe(Math.round(svc.priceCents * 0.4));
    expect(booking.body.deposit.method).toBe('transfer');
    expect(booking.body.deposit.transfer.clabe).toBe('012180001234567899');
    expect(booking.body.deposit.checkoutUrl).toBeNull();

    // payment link refuses disabled / unconnected online methods
    r = await call('POST', '/payments/link', { appointmentId: booking.body.id, amountCents: 1000, method: 'mercadopago' }, a.token);
    expect(r.status).toBe(422);
  });

  it('Mercado Pago connect rejects invalid tokens and never exposes them', async () => {
    const r = await call('PUT', '/tenant/mercadopago', { accessToken: 'APP_USR-0000000000-invalid-token-for-tests' }, a.token);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('mercadopago_invalid_token');
    const me = await call('GET', '/auth/me', undefined, a.token);
    expect(JSON.stringify(me.body)).not.toContain('APP_USR');
    const del = await call('DELETE', '/tenant/mercadopago', undefined, a.token);
    expect(del.status).toBe(200);
    expect(del.body.mercadoPago.connected).toBe(false);
  });
});

