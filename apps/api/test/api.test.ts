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
    // Test businesses sign up on Estándar (no customer cap) unless a test picks a plan.
    if (path === '/auth/register' && body && typeof body === 'object' && !('plan' in body)) body = { ...body, plan: 'standard' };
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

  it('emails the customer: confirmation, change, cancellation and reminder', async () => {
    const { sentInTests } = await import('../src/lib/email.js');
    const { sendDueReminders } = await import('../src/jobs/reminders.js');
    const svc = (await call('GET', '/services', undefined, a.token)).body[0];
    const cust = await call('POST', '/customers', { name: 'Correo Cliente', phone: '5512340099', email: 'cliente@correo.mx' }, a.token);
    const noMail = await call('POST', '/customers', { name: 'Sin Correo', phone: '5512340098' }, a.token);
    const fake = await call('POST', '/customers', { name: 'Demo Falso', phone: '5512340097', email: 'x1@example.com' }, a.token);
    sentInTests.length = 0;
    const when = DateTime.now().plus({ days: 3 }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    const appt = await call('POST', '/appointments', { customerId: cust.body.id, serviceId: svc.id, startsAt: when.toISO(), allowOverlap: true }, a.token);
    expect(appt.status).toBe(201);
    // No email address, or a reserved test domain: nothing is sent
    await call('POST', '/appointments', { customerId: noMail.body.id, serviceId: svc.id, startsAt: when.toISO(), allowOverlap: true }, a.token);
    await call('POST', '/appointments', { customerId: fake.body.id, serviceId: svc.id, startsAt: when.toISO(), allowOverlap: true }, a.token);
    expect(sentInTests).toHaveLength(1);
    expect(sentInTests[0]!.to).toBe('cliente@correo.mx');
    expect(sentInTests[0]!.subject).toContain('Negocio a');
    expect(sentInTests[0]!.text).toMatch(/\/c\/[A-Za-z0-9_.-]+/);
    // Moved by the business, then cancelled
    await call('PATCH', `/appointments/${appt.body.id}`, { startsAt: when.plus({ hours: 2 }).toISO(), allowOverlap: true }, a.token);
    expect(sentInTests[1]!.subject).toMatch(/Cambió/);
    await call('PATCH', `/appointments/${appt.body.id}`, { status: 'cancelled' }, a.token);
    expect(sentInTests[2]!.subject).toMatch(/cancel/);
    expect(sentInTests).toHaveLength(3);
    // Business turns confirmations off: none sent
    const me = (await call('GET', '/auth/me', undefined, a.token)).body.tenant.settings;
    await call('PATCH', '/tenant', { settings: { ...me, emailConfirmations: false } }, a.token);
    const soon = await call('POST', '/appointments', { customerId: cust.body.id, serviceId: svc.id, startsAt: DateTime.now().plus({ hours: 3 }).toISO(), allowOverlap: true }, a.token);
    expect(sentInTests).toHaveLength(3);
    // The reminder still goes out within the hours chosen (default 24)
    await sendDueReminders(200, 0);
    const reminder = sentInTests.find((m) => m.subject.startsWith('Recordatorio'));
    expect(reminder?.to).toBe('cliente@correo.mx');
    await call('PATCH', '/tenant', { settings: { ...me, emailConfirmations: true } }, a.token);
    await call('DELETE', `/appointments/${soon.body.id}`, undefined, a.token);
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

  it('reports: ranges, filters, comparison and tenant isolation', async () => {
    const today = DateTime.now().setZone('America/Mexico_City');
    const from = today.minus({ days: 29 }).toISODate();
    const to = today.toISODate();
    const r = await call('GET', `/reports?from=${from}&to=${to}`, undefined, a.token);
    expect(r.status).toBe(200);
    expect(r.body.granularity).toBe('day');
    expect(r.body.series).toHaveLength(30);
    expect(r.body.kpis.revenueCents).toBeGreaterThanOrEqual(20000);
    expect(r.body.kpis.completed).toBeGreaterThanOrEqual(1);
    expect(r.body.byService.find((s: { name: string }) => s.name === 'Corte')).toBeTruthy();
    expect(r.body.byMethod.find((m: { method: string }) => m.method === 'cash')?.revenueCents).toBeGreaterThanOrEqual(20000);
    expect(r.body.previousRange.to).toBe(today.minus({ days: 30 }).toISODate());
    const seriesRevenue = (r.body.series as { revenueCents: number }[]).reduce((acc, p) => acc + p.revenueCents, 0);
    expect(seriesRevenue).toBe(r.body.kpis.revenueCents);

    const weekly = await call('GET', `/reports?from=${from}&to=${to}&granularity=week`, undefined, a.token);
    expect(weekly.body.series.length).toBeGreaterThanOrEqual(5);
    expect(weekly.body.series.length).toBeLessThanOrEqual(6);

    const svc = (await call('GET', '/services', undefined, a.token)).body[0];
    const bySvc = await call('GET', `/reports?from=${from}&to=${to}&serviceId=${svc.id}`, undefined, a.token);
    expect(bySvc.body.kpis.revenueCents).toBe(r.body.kpis.revenueCents);
    const other = await call('GET', `/reports?from=${from}&to=${to}&serviceId=00000000-0000-4000-8000-000000000000`, undefined, a.token);
    expect(other.body.kpis.revenueCents).toBe(0);
    expect(other.body.kpis.appointments).toBe(0);
    const online = await call('GET', `/reports?from=${from}&to=${to}&source=online`, undefined, a.token);
    expect(online.body.kpis.revenueCents).toBe(0); // the paid appointment was booked by staff

    expect((await call('GET', `/reports?from=${to}&to=${from}`, undefined, a.token)).status).toBe(422);
    expect((await call('GET', `/reports?from=2000-01-01&to=${to}`, undefined, a.token)).status).toBe(422);
    expect((await call('GET', `/reports?from=${from}&to=${to}`)).status).toBe(401);

    const rb = await call('GET', `/reports?from=${from}&to=${to}`, undefined, b.token);
    expect(rb.body.kpis.revenueCents).toBe(0);
    expect(rb.body.byService).toHaveLength(0);
  });

  it('self-service link: view, reschedule, deadline and cancel', async () => {
    const pub = await call('GET', '/public/negocio-a');
    const svc = pub.body.services[0];
    // Close enough that the moved booking stays within the 7-day notice used below.
    let day = DateTime.now().setZone('America/Mexico_City').plus({ days: 2 });
    while (day.weekday === 7) day = day.plus({ days: 1 });
    const avail = await call('GET', `/public/negocio-a/availability?serviceId=${svc.id}&date=${day.toISODate()}`);
    const booking = await call('POST', '/public/negocio-a/bookings', { serviceId: svc.id, startsAt: avail.body.slots[4], name: 'Ana Reagenda', phone: '5543214321' });
    expect(booking.status).toBe(201);
    const path: string = booking.body.managePath;
    expect(path).toMatch(/^\/c\/[0-9a-f-]{36}\.[A-Za-z0-9_-]{24}$/);
    const token = path.slice(3);

    // Staff sees the same link
    const list = await call('GET', `/appointments?from=${day.startOf('day').toISO()}&to=${day.endOf('day').toISO()}`, undefined, a.token);
    expect(list.body.find((x: { id: string }) => x.id === booking.body.id)?.managePath).toBe(path);

    const view = await call('GET', `/public/manage/${token}`);
    expect(view.status).toBe(200);
    expect(view.body.appointment.customerFirstName).toBe('Ana');
    expect(JSON.stringify(view.body)).not.toContain('5543214321');
    expect(view.body.canReschedule).toBe(true);
    expect((await call('GET', `/public/manage/${token.slice(0, -2)}xx`)).status).toBe(404);

    let next = day.plus({ days: 1 });
    while (next.weekday === 7) next = next.plus({ days: 1 });
    const slots = await call('GET', `/public/manage/${token}/availability?date=${next.toISODate()}`);
    expect(slots.body.slots.length).toBeGreaterThan(0);
    const target = slots.body.slots[1];
    const moved = await call('POST', `/public/manage/${token}/reschedule`, { startsAt: target });
    expect(moved.status).toBe(200);
    expect(new Date(moved.body.appointment.startsAt).getTime()).toBe(new Date(target).getTime());
    const appt = (await call('GET', `/appointments?from=${next.startOf('day').toISO()}&to=${next.endOf('day').toISO()}`, undefined, a.token)).body.find((x: { id: string }) => x.id === booking.body.id);
    expect(appt.notes).toContain('Reagendada por el cliente');

    // Taken slot is rejected
    const other = await call('POST', '/public/negocio-a/bookings', { serviceId: svc.id, startsAt: slots.body.slots[3], name: 'Otro', phone: '5543214399' });
    expect(other.status).toBe(201);
    expect((await call('POST', `/public/manage/${token}/reschedule`, { startsAt: slots.body.slots[3] })).status).toBe(409);

    // Deadline: with 7 days notice required the change is refused
    const me = await call('GET', '/auth/me', undefined, a.token);
    const base = me.body.tenant.settings;
    expect(base.selfService).toEqual({ rescheduleEnabled: true, cancelEnabled: true, minHoursNotice: 24 });
    await call('PATCH', '/tenant', { settings: { ...base, selfService: { ...base.selfService, minHoursNotice: 168 } } }, a.token);
    const late = await call('GET', `/public/manage/${token}`);
    expect(late.body.reason).toBe('too_late');
    expect((await call('POST', `/public/manage/${token}/cancel`)).body.error).toBe('too_late');
    await call('PATCH', '/tenant', { settings: base }, a.token);

    const cancelled = await call('POST', `/public/manage/${token}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.appointment.status).toBe('cancelled');
    expect((await call('POST', `/public/manage/${token}/cancel`)).status).toBe(422);
    expect((await call('POST', `/public/manage/${token}/reschedule`, { startsAt: target })).status).toBe(422);
  });

  it('restaurants: tables, party-size availability, auto assignment and capacity', async () => {
    const reg = await call('POST', '/auth/register', {
      businessName: 'Restaurante Prueba', businessType: 'restaurant', name: 'Chef', email: 'chef@test.mx', password: 'password123',
    });
    expect(reg.status).toBe(201);
    const tok = reg.body.token;
    expect(reg.body.tenant.kind).toBe('reservations');
    const tables = await call('GET', '/resources', undefined, tok);
    expect(tables.body.map((t: { capacity: number }) => t.capacity)).toEqual([2, 2, 4, 4, 6]);
    // B can't see A's tables
    expect((await call('GET', '/resources', undefined, b.token)).body).toHaveLength(0);
    expect((await call('PUT', `/resources/${tables.body[0].id}`, { name: 'x', capacity: 2 }, b.token)).status).toBe(404);

    const pub = await call('GET', '/public/restaurante-prueba');
    expect(pub.body.kind).toBe('reservations');
    expect(pub.body.maxPartySize).toBe(8);

    let day = DateTime.now().setZone('America/Mexico_City').plus({ days: 4 });
    while (day.weekday === 7) day = day.plus({ days: 1 });
    const d = day.toISODate();
    const av = await call('GET', `/public/restaurante-prueba/availability?partySize=2&date=${d}`);
    expect(av.body.slots.length).toBeGreaterThan(0);
    const slot = av.body.slots[0];
    expect((await call('GET', `/public/restaurante-prueba/availability?partySize=9&date=${d}`)).body.slots).toHaveLength(0);

    // Two 2-seat tables, then 4-seat tables, then the 6-seat one: five parties of 2 fit, a sixth doesn't.
    const seated: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await call('POST', '/public/restaurante-prueba/bookings', { partySize: 2, startsAt: slot, name: `Grupo ${i}`, phone: `55000011${10 + i}` });
      expect(r.status).toBe(201);
      expect(r.body.partySize).toBe(2);
      seated.push(r.body.id);
    }
    const full = await call('POST', '/public/restaurante-prueba/bookings', { partySize: 2, startsAt: slot, name: 'Grupo 6', phone: '5500001199' });
    expect(full.status).toBe(409);
    expect((await call('GET', `/public/restaurante-prueba/availability?partySize=2&date=${d}`)).body.slots).not.toContain(slot);
    expect((await call('POST', '/public/restaurante-prueba/bookings', { partySize: 12, startsAt: slot, name: 'Grande', phone: '5500001198' })).status).toBe(422);

    const list = await call('GET', `/appointments?from=${day.startOf('day').toISO()}&to=${day.endOf('day').toISO()}`, undefined, tok);
    const names = list.body.map((a: { resourceName: string }) => a.resourceName).sort();
    expect(names).toEqual(['Mesa 1', 'Mesa 2', 'Mesa 3', 'Mesa 4', 'Mesa 5']);
    expect(new Set(list.body.map((a: { resourceId: string }) => a.resourceId)).size).toBe(5);

    // Staff reservation at the same time has no table left -> 409; with allowOverlap it's saved without a table
    const cust = await call('POST', '/customers', { name: 'Walk In', phone: '5512345000' }, tok);
    const svc = (await call('GET', '/services', undefined, tok)).body[0];
    const noRoom = await call('POST', '/appointments', { customerId: cust.body.id, serviceId: svc.id, startsAt: slot, partySize: 2 }, tok);
    expect(noRoom.status).toBe(409);
    expect(noRoom.body.error).toBe('no_resource_available');
    const walkIn = await call('POST', '/appointments', { customerId: cust.body.id, serviceId: svc.id, startsAt: slot, partySize: 2, allowOverlap: true }, tok);
    expect(walkIn.status).toBe(201);
    expect(walkIn.body.resourceId).toBeNull();

    // The walk-in without a table still takes a table's worth of room, so one cancellation isn't enough
    await call('PATCH', `/appointments/${seated[0]}`, { status: 'cancelled' }, tok);
    expect((await call('POST', '/public/restaurante-prueba/bookings', { partySize: 2, startsAt: slot, name: 'Grupo 7', phone: '5500001197' })).status).toBe(409);
    // Cancelling the walk-in too frees a table for the next booking
    await call('PATCH', `/appointments/${walkIn.body.id}`, { status: 'cancelled' }, tok);
    expect((await call('POST', '/public/restaurante-prueba/bookings', { partySize: 2, startsAt: slot, name: 'Grupo 7', phone: '5500001197' })).status).toBe(201);

    // Customer reschedule keeps a table
    const one = (await call('GET', `/appointments?from=${day.startOf('day').toISO()}&to=${day.endOf('day').toISO()}`, undefined, tok)).body.find((a: { resourceId: string | null; status: string }) => a.resourceId && a.status === 'scheduled');
    const later = av.body.slots[av.body.slots.length - 1];
    const moved = await call('POST', `/public/manage/${one.managePath.slice(3)}/reschedule`, { startsAt: later });
    expect(moved.status).toBe(200);
    expect(moved.body.appointment.partySize).toBe(2);
  });

  it('team: per-professional agendas, any/specific booking and service limits', async () => {
    const reg = await call('POST', '/auth/register', {
      businessName: 'Barberia Equipo', businessType: 'barbershop', name: 'Dueño', email: 'equipo@test.mx', password: 'password123',
    });
    const tok = reg.body.token;
    const corte = (await call('POST', '/services', { name: 'Corte', durationMin: 30, priceCents: 20000 }, tok)).body;
    const barba = (await call('POST', '/services', { name: 'Barba', durationMin: 30, priceCents: 15000 }, tok)).body;
    const cust = (await call('POST', '/customers', { name: 'Cliente Equipo', phone: '5533330000' }, tok)).body;
    let day = DateTime.now().setZone('America/Mexico_City').plus({ days: 5 });
    while (day.weekday === 7) day = day.plus({ days: 1 });
    const at = (h: number, m = 0) => day.set({ hour: h, minute: m, second: 0, millisecond: 0 }).toISO()!;

    // A single-agenda appointment made before the team existed...
    const pre = (await call('POST', '/appointments', { customerId: cust.id, serviceId: corte.id, startsAt: at(10) }, tok)).body;
    const p1 = await call('POST', '/resources', { name: 'Toño', color: '#2563eb' }, tok);
    expect(p1.status).toBe(201);
    // ...goes to the first professional
    expect((await call('GET', `/appointments/${pre.id}`, undefined, tok)).body.resourceName).toBe('Toño');
    const p2 = (await call('POST', '/resources', { name: 'Memo', serviceIds: [corte.id] }, tok)).body;
    expect(p2.serviceIds).toEqual([corte.id]);
    expect((await call('GET', '/resources', undefined, b.token)).body).toHaveLength(0);
    expect((await call('PUT', `/resources/${p2.id}`, { name: 'x' }, b.token)).status).toBe(404);
    expect((await call('POST', '/resources', { name: 'Raro', serviceIds: [corte.id] }, b.token)).status).toBe(404);

    const pub = await call('GET', '/public/barberia-equipo');
    expect(pub.body.resources.map((p: { name: string }) => p.name)).toEqual(['Memo', 'Toño']);
    expect(JSON.stringify(pub.body.resources)).not.toContain('userId');
    const avail = async (svc: string, pro?: string) =>
      (await call('GET', `/public/barberia-equipo/availability?serviceId=${svc}&date=${day.toISODate()}${pro ? `&resourceId=${pro}` : ''}`)).body.slots as string[];
    expect(await avail(corte.id)).toContain(at(10)); // Memo is free
    expect(await avail(corte.id, p1.body.id)).not.toContain(at(10));
    expect(await avail(barba.id)).not.toContain(at(10)); // only Toño does beards
    expect(await avail(barba.id)).toContain(at(11));

    const any = await call('POST', '/public/barberia-equipo/bookings', { serviceId: corte.id, startsAt: at(10), name: 'Ana', phone: '5533330001' });
    expect(any.status).toBe(201);
    expect(any.body.resourceName).toBe('Memo');
    expect((await call('POST', '/public/barberia-equipo/bookings', { serviceId: corte.id, startsAt: at(10), name: 'Beto', phone: '5533330002' })).status).toBe(409);
    const specific = await call('POST', '/public/barberia-equipo/bookings', { serviceId: corte.id, resourceId: p2.id, startsAt: at(10, 30), name: 'Caro', phone: '5533330003' });
    expect(specific.body.resourceName).toBe('Memo');

    // Staff: busy professional -> 409; allowOverlap -> saved; wrong service -> 422
    const busy = await call('POST', '/appointments', { customerId: cust.id, serviceId: corte.id, resourceId: p1.body.id, startsAt: at(10) }, tok);
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe('resource_busy');
    expect((await call('POST', '/appointments', { customerId: cust.id, serviceId: corte.id, resourceId: p1.body.id, startsAt: at(10), allowOverlap: true }, tok)).status).toBe(201);
    const wrong = await call('POST', '/appointments', { customerId: cust.id, serviceId: barba.id, resourceId: p2.id, startsAt: at(12) }, tok);
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toBe('resource_service');
    const auto = await call('POST', '/appointments', { customerId: cust.id, serviceId: barba.id, startsAt: at(12) }, tok);
    expect(auto.body.resourceName).toBe('Toño');
    // Moving Toño's beard to a time Toño is busy fails; moving it to a free time works
    expect((await call('PATCH', `/appointments/${auto.body.id}`, { startsAt: at(10) }, tok)).status).toBe(409);
    expect((await call('PATCH', `/appointments/${auto.body.id}`, { startsAt: at(13) }, tok)).status).toBe(200);

    // Customer reschedule keeps their professional
    const moved = await call('POST', `/public/manage/${any.body.managePath.slice(3)}/reschedule`, { startsAt: at(11) });
    expect(moved.status).toBe(200);
    expect(moved.body.appointment.resourceName).toBe('Memo');

    const rep = await call('GET', `/reports?from=${day.minus({ days: 30 }).toISODate()}&to=${day.toISODate()}&resourceId=${p2.id}`, undefined, tok);
    expect(rep.status).toBe(200);
    expect(Array.isArray(rep.body.byResource)).toBe(true);
    // Professionals with history are deactivated, not deleted
    expect((await call('DELETE', `/resources/${p2.id}`, undefined, tok)).body.deactivated).toBe(true);
  });

  it('classes: sessions with capacity, public signup, move and cancel', async () => {
    const reg = await call('POST', '/auth/register', {
      businessName: 'Estudio Prueba', businessType: 'yoga', name: 'Lau', email: 'yoga@test.mx', password: 'password123',
    });
    const tok = reg.body.token;
    expect(reg.body.tenant.kind).toBe('classes');
    expect((await call('GET', '/services', undefined, tok)).body.map((s: { name: string }) => s.name)).toContain('Clase grupal');
    const svc = (await call('POST', '/services', { name: 'Vinyasa', durationMin: 60, priceCents: 15000 }, tok)).body;
    const inst = (await call('POST', '/resources', { name: 'Lau' }, tok)).body;
    const day = DateTime.now().setZone('America/Mexico_City').plus({ days: 3 }).set({ hour: 8, minute: 0, second: 0, millisecond: 0 });

    const s1 = await call('POST', '/class-sessions', { serviceId: svc.id, resourceId: inst.id, startsAt: day.toISO(), capacity: 2 }, tok);
    expect(s1.status).toBe(201);
    expect(s1.body.booked).toBe(0);
    expect(new Date(s1.body.endsAt).getTime() - new Date(s1.body.startsAt).getTime()).toBe(3600e3);
    const clash = await call('POST', '/class-sessions', { serviceId: svc.id, resourceId: inst.id, startsAt: day.plus({ minutes: 30 }).toISO(), capacity: 5 }, tok);
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('resource_busy');
    const copy = await call('POST', `/class-sessions/${s1.body.id}/copy`, { days: 1 }, tok);
    expect(copy.status).toBe(201);
    expect(new Date(copy.body.startsAt).getTime() - new Date(s1.body.startsAt).getTime()).toBe(86400e3);
    expect((await call('GET', `/class-sessions/${s1.body.id}`, undefined, b.token)).status).toBe(404);

    const list = (await call('GET', '/public/estudio-prueba/classes')).body;
    const pubS1 = list.find((x: { id: string }) => x.id === s1.body.id);
    expect(pubS1).toMatchObject({ spotsLeft: 2, priceCents: 15000, resourceName: 'Lau', serviceName: 'Vinyasa' });
    const b1 = await call('POST', '/public/estudio-prueba/bookings', { classSessionId: s1.body.id, name: 'Alumna Uno', phone: '5544440001' });
    expect(b1.status).toBe(201);
    expect(b1.body).toMatchObject({ priceCents: 15000, resourceName: 'Lau', partySize: 1 });
    const dup = await call('POST', '/public/estudio-prueba/bookings', { classSessionId: s1.body.id, name: 'Alumna Uno', phone: '5544440001' });
    expect(dup.body.error).toBe('already_booked');
    expect((await call('POST', '/public/estudio-prueba/bookings', { classSessionId: s1.body.id, name: 'Alumno Dos', phone: '5544440002' })).status).toBe(201);
    const full = await call('POST', '/public/estudio-prueba/bookings', { classSessionId: s1.body.id, name: 'Alumno Tres', phone: '5544440003' });
    expect(full.status).toBe(409);
    expect(full.body.error).toBe('class_full');
    expect((await call('GET', '/public/estudio-prueba/classes')).body.find((x: { id: string }) => x.id === s1.body.id).spotsLeft).toBe(0);

    // Customer moves to the next day's class
    const tokB1 = b1.body.managePath.slice(3);
    const av = await call('GET', `/public/manage/${tokB1}/availability?date=${day.plus({ days: 1 }).toISODate()}`);
    expect(av.body.slots.map((x: string) => new Date(x).getTime())).toContain(new Date(copy.body.startsAt).getTime());
    const mv = await call('POST', `/public/manage/${tokB1}/reschedule`, { startsAt: copy.body.startsAt });
    expect(mv.status).toBe(200);
    const detail = await call('GET', `/class-sessions/${s1.body.id}`, undefined, tok);
    expect(detail.body.session.booked).toBe(1);
    expect(detail.body.attendees).toHaveLength(1);

    // Staff adds attendees: room for one, then full, overbooking allowed explicitly
    const cust = (await call('POST', '/customers', { name: 'En Mostrador', phone: '5544440009' }, tok)).body;
    expect((await call('POST', '/appointments', { customerId: cust.id, classSessionId: s1.body.id }, tok)).status).toBe(201);
    expect((await call('POST', '/appointments', { customerId: cust.id, classSessionId: s1.body.id }, tok)).body.error).toBe('class_full');
    expect((await call('POST', '/appointments', { customerId: cust.id, classSessionId: s1.body.id, allowOverlap: true }, tok)).status).toBe(201);
    expect((await call('PATCH', `/class-sessions/${s1.body.id}`, { capacity: 1 }, tok)).body.error).toBe('capacity_below_booked');
    // Moving the class moves its attendees
    const later = day.plus({ hours: 2 }).toISO()!;
    expect((await call('PATCH', `/class-sessions/${s1.body.id}`, { startsAt: later, capacity: 5 }, tok)).status).toBe(200);
    const after = await call('GET', `/class-sessions/${s1.body.id}`, undefined, tok);
    expect(after.body.attendees.every((a: { startsAt: string }) => new Date(a.startsAt).getTime() === new Date(later).getTime())).toBe(true);

    // Cancelling a class cancels its bookings; classes with bookings can't be deleted
    const cancelled = await call('POST', `/class-sessions/${copy.body.id}/cancel`, undefined, tok);
    expect(cancelled.body.status).toBe('cancelled');
    const copyDetail = await call('GET', `/class-sessions/${copy.body.id}`, undefined, tok);
    expect(copyDetail.body.attendees.every((a: { status: string }) => a.status === 'cancelled')).toBe(true);
    expect((await call('DELETE', `/class-sessions/${s1.body.id}`, undefined, tok)).status).toBe(409);
    const empty = (await call('POST', '/class-sessions', { serviceId: svc.id, startsAt: day.plus({ days: 5 }).toISO(), capacity: 3 }, tok)).body;
    expect((await call('DELETE', `/class-sessions/${empty.id}`, undefined, tok)).status).toBe(204);
  });

  it('rentals: spaces by the hour, durations, any/specific and pricing', async () => {
    const reg = await call('POST', '/auth/register', {
      businessName: 'Padel Prueba', businessType: 'sports', name: 'Club', email: 'padel@test.mx', password: 'password123',
    });
    const tok = reg.body.token;
    expect(reg.body.tenant.kind).toBe('rentals');
    const list = (await call('GET', '/resources', undefined, tok)).body;
    expect(list.map((x: { name: string }) => x.name)).toEqual(['Cancha 1', 'Cancha 2']);
    const [c1, c2] = list;
    await call('PUT', `/resources/${c1.id}`, { name: 'Cancha 1', pricePerHourCents: 40000 }, tok);
    await call('PUT', `/resources/${c2.id}`, { name: 'Cancha 2', pricePerHourCents: 50000 }, tok);
    expect((await call('GET', '/resources', undefined, b.token)).body).toHaveLength(0);
    expect((await call('PUT', `/resources/${c1.id}`, { name: 'x', pricePerHourCents: 1 }, b.token)).status).toBe(404);

    const pub = (await call('GET', '/public/padel-prueba')).body;
    expect(pub).toMatchObject({ kind: 'rentals', rentalDurations: [60, 90, 120], services: [] });
    expect(pub.resources.map((x: { pricePerHourCents: number }) => x.pricePerHourCents)).toEqual([40000, 50000]);

    let day = DateTime.now().setZone('America/Mexico_City').plus({ days: 2 });
    while (day.weekday === 7) day = day.plus({ days: 1 });
    const at = (h: number, m = 0) => day.set({ hour: h, minute: m, second: 0, millisecond: 0 }).toISO()!;
    const avail = async (dur: number, space?: string) =>
      (await call('GET', `/public/padel-prueba/availability?durationMin=${dur}&date=${day.toISODate()}${space ? `&resourceId=${space}` : ''}`)).body.slots as string[];
    expect(await avail(90)).toContain(at(10));
    expect((await call('GET', `/public/padel-prueba/availability?durationMin=45&date=${day.toISODate()}`)).status).toBe(422);

    const r1 = await call('POST', '/public/padel-prueba/bookings', { resourceId: c1.id, durationMin: 90, startsAt: at(10), name: 'Jugador Uno', phone: '5566660001' });
    expect(r1.status).toBe(201);
    expect(r1.body).toMatchObject({ priceCents: 60000, resourceName: 'Cancha 1' });
    const c1Slots = await avail(60, c1.id);
    expect(c1Slots).not.toContain(at(10, 30));
    expect(c1Slots).toContain(at(11, 30));
    expect(await avail(60)).toContain(at(10));
    const r2 = await call('POST', '/public/padel-prueba/bookings', { durationMin: 60, startsAt: at(10), name: 'Jugador Dos', phone: '5566660002' });
    expect(r2.body).toMatchObject({ priceCents: 50000, resourceName: 'Cancha 2' });
    expect((await call('POST', '/public/padel-prueba/bookings', { durationMin: 60, startsAt: at(10), name: 'Jugador Tres', phone: '5566660003' })).status).toBe(409);
    expect((await call('POST', '/public/padel-prueba/bookings', { durationMin: 45, startsAt: at(15), name: 'Jugador Tres', phone: '5566660003' })).status).toBe(422);

    const cust = (await call('POST', '/customers', { name: 'Socio', phone: '5566660009' }, tok)).body;
    const taken = await call('POST', '/appointments', { customerId: cust.id, resourceId: c1.id, startsAt: at(10, 30), durationMin: 60 }, tok);
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe('resource_busy');
    const staff = await call('POST', '/appointments', { customerId: cust.id, startsAt: at(12), durationMin: 120 }, tok);
    expect(staff.status).toBe(201);
    expect(staff.body).toMatchObject({ resourceName: 'Cancha 1', priceCents: 80000 });

    const mv = await call('POST', `/public/manage/${r1.body.managePath.slice(3)}/reschedule`, { startsAt: at(15) });
    expect(mv.status).toBe(200);
    expect(mv.body.appointment.resourceName).toBe('Cancha 1');

    const settings = { ...reg.body.tenant.settings, rentals: { durations: [60] } };
    expect((await call('PATCH', '/tenant', { settings }, tok)).body.settings.rentals.durations).toEqual([60]);
    const rep = await call('GET', `/reports?from=${day.minus({ days: 1 }).toISODate()}&to=${day.toISODate()}`, undefined, tok);
    expect(Array.isArray(rep.body.byResource)).toBe(true);
  });

  it('roles: owner, admin and team members only see their own bookings', async () => {
    const owner = (await call('POST', '/auth/register', {
      businessName: 'Barberia Roles', businessType: 'barbershop', name: 'Dueña', email: 'roles-owner@test.mx', password: 'password123',
    })).body as AuthResponse;
    const tok = owner.token;
    expect(owner.user).toMatchObject({ role: 'owner', resourceId: null });
    const svc = (await call('POST', '/services', { name: 'Corte', durationMin: 30, priceCents: 20000 }, tok)).body;
    const pA = (await call('POST', '/resources', { name: 'Ana' }, tok)).body;
    const pB = (await call('POST', '/resources', { name: 'Beto' }, tok)).body;

    // Owner creates an admin and a team member linked to Ana
    const admin = await call('POST', '/users', { name: 'Recepción', email: 'roles-admin@test.mx', password: 'password123', role: 'admin' }, tok);
    expect(admin.status).toBe(201);
    const staff = await call('POST', '/users', { name: 'Ana', email: 'roles-ana@test.mx', password: 'password123', role: 'staff', resourceId: pA.id }, tok);
    expect(staff.body).toMatchObject({ role: 'staff', resourceId: pA.id, resourceName: 'Ana' });
    const adminTok = (await call('POST', '/auth/login', { email: 'roles-admin@test.mx', password: 'password123' })).body.token;
    const anaLogin = (await call('POST', '/auth/login', { email: 'roles-ana@test.mx', password: 'password123' })).body;
    expect(anaLogin.user).toMatchObject({ role: 'staff', resourceId: pA.id });
    const anaTok = anaLogin.token;

    // Admin can only create team members, not other admins/owners
    expect((await call('POST', '/users', { name: 'Equis', email: 'roles-x@test.mx', password: 'password123', role: 'admin' }, adminTok)).status).toBe(403);
    expect((await call('POST', '/users', { name: 'Beto', email: 'roles-beto@test.mx', password: 'password123', role: 'staff', resourceId: pB.id }, adminTok)).status).toBe(201);
    // Team members can't see or manage logins, catalog or team
    expect((await call('GET', '/users', undefined, anaTok)).status).toBe(403);
    expect((await call('POST', '/services', { name: 'Tinte', durationMin: 60, priceCents: 1 }, anaTok)).status).toBe(403);
    expect((await call('POST', '/resources', { name: 'Nadie' }, anaTok)).status).toBe(403);
    expect((await call('PATCH', '/tenant', { name: 'Hackeado' }, anaTok)).status).toBe(403);
    // Admin runs the business but can't touch payment settings or Mercado Pago
    expect((await call('POST', '/services', { name: 'Tinte', durationMin: 60, priceCents: 50000 }, adminTok)).status).toBe(201);
    expect((await call('PUT', '/tenant/mercadopago', { accessToken: 'APP_USR-12345678901234567890' }, adminTok)).status).toBe(403);

    // Bookings for both barbers
    const cust1 = (await call('POST', '/customers', { name: 'Cliente Ana', phone: '5560000001' }, tok)).body;
    const cust2 = (await call('POST', '/customers', { name: 'Cliente Beto', phone: '5560000002' }, tok)).body;
    const at = DateTime.now().plus({ days: 3 }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    const apA = (await call('POST', '/appointments', { customerId: cust1.id, serviceId: svc.id, resourceId: pA.id, startsAt: at.toISO() }, tok)).body;
    const apB = (await call('POST', '/appointments', { customerId: cust2.id, serviceId: svc.id, resourceId: pB.id, startsAt: at.toISO() }, tok)).body;
    expect(apA.resourceId).toBe(pA.id);
    expect(apB.resourceId).toBe(pB.id);
    const range = `from=${encodeURIComponent(at.minus({ days: 1 }).toISO()!)}&to=${encodeURIComponent(at.plus({ days: 1 }).toISO()!)}`;

    expect((await call('GET', `/appointments?${range}`, undefined, tok)).body).toHaveLength(2);
    expect((await call('GET', `/appointments?${range}`, undefined, adminTok)).body).toHaveLength(2);
    const mine = (await call('GET', `/appointments?${range}`, undefined, anaTok)).body;
    expect(mine.map((x: { id: string }) => x.id)).toEqual([apA.id]);
    expect((await call('GET', `/appointments/${apB.id}`, undefined, anaTok)).status).toBe(404);
    expect((await call('PATCH', `/appointments/${apB.id}`, { status: 'cancelled' }, anaTok)).status).toBe(404);
    expect((await call('PATCH', `/appointments/${apA.id}`, { resourceId: pB.id }, anaTok)).status).toBe(403);
    expect((await call('DELETE', `/appointments/${apA.id}`, undefined, anaTok)).status).toBe(403);
    // Ana books into her own agenda only
    expect((await call('POST', '/appointments', { customerId: cust2.id, serviceId: svc.id, resourceId: pB.id, startsAt: at.plus({ hours: 2 }).toISO() }, anaTok)).status).toBe(403);
    const own = await call('POST', '/appointments', { customerId: cust2.id, serviceId: svc.id, startsAt: at.plus({ hours: 2 }).toISO() }, anaTok);
    expect(own.status).toBe(201);
    expect(own.body.resourceId).toBe(pA.id);
    // Completing her own booking with a payment
    const done = await call('PATCH', `/appointments/${apA.id}`, { status: 'completed', paymentMethod: 'cash' }, anaTok);
    expect(done.status).toBe(200);
    await call('PATCH', `/appointments/${apB.id}`, { status: 'completed', paymentMethod: 'card' }, tok);

    // Customers: only hers (Cliente Beto appears because Ana now has a booking with them)
    const custs = (await call('GET', '/customers', undefined, anaTok)).body;
    expect(custs.items.map((x: { name: string }) => x.name).sort()).toEqual(['Cliente Ana', 'Cliente Beto']);
    const beto = custs.items.find((x: { name: string }) => x.name === 'Cliente Beto');
    expect(beto.totalSpentCents).toBe(0); // Beto's payment isn't Ana's
    const other = (await call('POST', '/customers', { name: 'Ajeno', phone: '5560000003' }, tok)).body;
    expect((await call('GET', `/customers/${other.id}`, undefined, anaTok)).status).toBe(404);
    expect((await call('GET', '/customers?q=Ajeno', undefined, anaTok)).body.items).toHaveLength(0);
    expect((await call('GET', '/customers?q=Ajeno&for=booking', undefined, anaTok)).body.items).toHaveLength(1);
    expect((await call('DELETE', `/customers/${cust1.id}`, undefined, anaTok)).status).toBe(403);

    // Payments, dashboard and reports only count her work
    const pays = (await call('GET', '/payments', undefined, anaTok)).body;
    expect(pays).toHaveLength(1);
    expect(pays[0].amountCents).toBe(20000);
    expect((await call('GET', '/payments', undefined, tok)).body).toHaveLength(2);
    expect((await call('POST', '/payments', { customerId: cust2.id, appointmentId: apB.id, amountCents: 100, method: 'cash', status: 'paid' }, anaTok)).status).toBe(403);
    const day = at.toISODate()!;
    const today = DateTime.now().toISODate()!;
    const rep = (await call('GET', `/reports?from=${today}&to=${day}&resourceId=${pB.id}`, undefined, anaTok)).body;
    expect(rep.kpis.completed).toBe(1);
    expect(rep.byResource.map((x: { name: string }) => x.name)).toEqual(['Ana']);
    const repAll = (await call('GET', `/reports?from=${today}&to=${day}`, undefined, adminTok)).body;
    expect(repAll.kpis.completed).toBe(2);

    // Role changes apply immediately; admins can't promote; the last owner stays an owner
    expect((await call('PATCH', `/users/${owner.user.id}`, { role: 'staff' }, tok)).body.error).toBe('own_role');
    const anaId = staff.body.id;
    expect((await call('PATCH', `/users/${anaId}`, { role: 'admin' }, adminTok)).status).toBe(403);
    expect((await call('PATCH', `/users/${anaId}`, { role: 'admin' }, tok)).status).toBe(200);
    expect((await call('GET', `/appointments?${range}`, undefined, anaTok)).body).toHaveLength(3);
    await call('PATCH', `/users/${anaId}`, { role: 'staff' }, tok);
    expect((await call('GET', `/appointments?${range}`, undefined, anaTok)).body).toHaveLength(2);
    // Unlinked team member works like front desk: sees the whole book of the business
    await call('PATCH', `/users/${anaId}`, { resourceId: null }, tok);
    expect((await call('GET', `/appointments?${range}`, undefined, anaTok)).body).toHaveLength(3);
    // Removing the login revokes access right away
    expect((await call('DELETE', `/users/${anaId}`, undefined, tok)).status).toBe(204);
    expect((await call('GET', `/appointments?${range}`, undefined, anaTok)).status).toBe(401);
    // Other businesses can't touch these users
    expect((await call('PATCH', `/users/${anaId}`, { role: 'owner' }, b.token)).status).toBe(404);
  });

  it('public directory: opt-in, location required, only public fields', async () => {
    // Not listed by default
    let dir = await call('GET', '/public-directory');
    expect(dir.status).toBe(200);
    expect(dir.body.entries.find((e: { slug: string }) => e.slug === 'negocio-a')).toBeUndefined();

    const me = await call('GET', '/auth/me', undefined, a.token);
    expect(me.body.tenant.profile.directoryListed).toBe(false);
    // Listing without a location is rejected
    let r = await call('PATCH', '/tenant', { profile: { ...me.body.tenant.profile, directoryListed: true } }, a.token);
    expect(r.status).toBe(422);
    r = await call('PATCH', '/tenant', { profile: { ...me.body.tenant.profile, lat: 99, lng: 0, city: 'X', directoryListed: true } }, a.token);
    expect(r.status).toBe(422);
    r = await call('PATCH', '/tenant', {
      profile: { description: 'Cortes', address: 'Calle 1', neighborhood: 'Roma Norte', city: 'Ciudad de México', state: 'Ciudad de México', lat: 19.42, lng: -99.16, directoryListed: true },
    }, a.token);
    expect(r.status).toBe(200);
    expect(r.body.profile.city).toBe('Ciudad de México');

    dir = await call('GET', '/public-directory');
    const entry = dir.body.entries.find((e: { slug: string }) => e.slug === 'negocio-a');
    expect(entry).toMatchObject({ name: 'Negocio a', businessType: 'barbershop', city: 'Ciudad de México', lat: 19.42, onlineBooking: true });
    expect(entry.priceFromCents).toBe(20000);
    expect(dir.body.zones).toContainEqual({ state: 'Ciudad de México', cities: ['Ciudad de México'] });
    const raw = JSON.stringify(dir.body);
    for (const leak of ['owner-a@test.mx', 'Juan Pérez', 'settings', 'mp_access', 'tenant_id']) expect(raw).not.toContain(leak);

    const pub = await call('GET', '/public/negocio-a');
    expect(pub.body).toMatchObject({ neighborhood: 'Roma Norte', lat: 19.42, kind: 'appointments', maxPartySize: null });

    // Staff can't change the profile; turning it off hides it again
    const staff = await call('POST', '/auth/login', { email: 'staff-a@test.mx', password: 'password123' });
    expect((await call('PATCH', '/tenant', { profile: { ...r.body.profile, directoryListed: false } }, staff.body.token)).status).toBe(403);
    await call('PATCH', '/tenant', { profile: { ...r.body.profile, directoryListed: false } }, a.token);
    dir = await call('GET', '/public-directory');
    expect(dir.body.entries.find((e: { slug: string }) => e.slug === 'negocio-a')).toBeUndefined();
  });
  it('one login, several businesses; locations with their own team, hours and managers', async () => {
    const reg = (await call('POST', '/auth/register', {
      businessName: 'Multi Uno', businessType: 'barbershop', name: 'Jorge', email: 'multi@test.mx', password: 'password123',
    })).body as AuthResponse;
    expect(reg.businesses).toHaveLength(1);
    // A second business for the same login (billed separately)
    const second = await call('POST', '/businesses', { businessName: 'Multi Dos', businessType: 'restaurant' }, reg.token);
    expect(second.status).toBe(201);
    expect(second.body.tenant.kind).toBe('reservations');
    expect(second.body.businesses.map((x: { name: string }) => x.name).sort()).toEqual(['Multi Dos', 'Multi Uno']);
    expect((await call('GET', '/resources', undefined, second.body.token)).body.length).toBeGreaterThan(0);
    // Switch back and forth; other people's businesses are off limits
    const back = await call('POST', '/auth/switch', { tenantId: reg.tenant.id }, second.body.token);
    expect(back.status).toBe(200);
    expect(back.body.tenant.id).toBe(reg.tenant.id);
    expect((await call('POST', '/auth/switch', { tenantId: b.tenant.id }, reg.token)).status).toBe(404);
    // Login opens the last business used
    const login = (await call('POST', '/auth/login', { email: 'multi@test.mx', password: 'password123' })).body;
    expect(login.tenant.id).toBe(reg.tenant.id);
    const tok = back.body.token as string;

    // Locations: one included, extras counted for billing
    const locs0 = (await call('GET', '/locations', undefined, tok)).body;
    expect(locs0.locations).toHaveLength(1);
    expect(locs0.locations[0].isPrimary).toBe(true);
    expect(locs0.plan).toMatchObject({ includedLocations: 1, activeLocations: 1, extraLocations: 0 });
    const main = locs0.locations[0];
    const created = await call('POST', '/locations', {
      name: 'Polanco', address: 'Homero 1', city: 'CDMX', state: 'CDMX', lat: 19.43, lng: -99.2,
      hours: { days: [1, 2, 3, 4, 5, 6, 7], open: '15:00', close: '17:00', slotMinutes: 30 },
    }, tok);
    expect(created.status).toBe(201);
    expect(created.body.plan.extraLocations).toBe(1);
    const pol = created.body.location;
    expect((await call('PUT', `/locations/${main.id}`, { name: main.name, active: false }, tok)).body.error).toBe('primary_location');
    // Another business can't use this location
    expect((await call('POST', '/resources', { name: 'Intruso', locationId: pol.id }, b.token)).status).toBe(404);

    const svc = (await call('POST', '/services', { name: 'Corte', durationMin: 30, priceCents: 20000 }, tok)).body;
    const pMain = (await call('POST', '/resources', { name: 'Centro Uno' }, tok)).body;
    const pPol = (await call('POST', '/resources', { name: 'Polanco Uno', locationId: pol.id }, tok)).body;
    expect(pMain.locationId).toBe(main.id);
    expect(pPol.locationId).toBe(pol.id);

    // Public page lists both locations; availability follows each location's hours and team
    await call('PATCH', '/tenant', { settings: { ...reg.tenant.settings, onlineBookingEnabled: true } }, tok);
    const pub = (await call('GET', `/public/${reg.tenant.slug}`)).body;
    expect(pub.locations.map((l: { name: string }) => l.name).sort()).toEqual(['Polanco', 'Principal']);
    expect(pub.resources.find((p: { id: string }) => p.id === pPol.id).locationId).toBe(pol.id);
    const day = DateTime.now().setZone('America/Mexico_City').plus({ days: 2 }).toISODate()!;
    const slots = (await call('GET', `/public/${reg.tenant.slug}/availability?serviceId=${svc.id}&date=${day}&locationId=${pol.id}`)).body.slots as string[];
    expect(slots.length).toBe(4);
    expect(slots.every((x) => { const h = DateTime.fromISO(x).setZone('America/Mexico_City').hour; return h >= 15 && h < 17; })).toBe(true);
    const booked = await call('POST', `/public/${reg.tenant.slug}/bookings`, {
      serviceId: svc.id, startsAt: slots[0], name: 'Cliente Polanco', phone: '5561110001', locationId: pol.id,
    });
    expect(booked.status).toBe(201);
    expect(booked.body.resourceName).toBe('Polanco Uno');

    // Staff-side booking in the main location
    const cust = (await call('POST', '/customers', { name: 'Cliente Centro', phone: '5561110002' }, tok)).body;
    const at = DateTime.now().plus({ days: 2 }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    const apMain = (await call('POST', '/appointments', { customerId: cust.id, serviceId: svc.id, startsAt: at.toISO() }, tok)).body;
    expect(apMain.locationId).toBe(main.id);
    expect(apMain.resourceId).toBe(pMain.id);

    // A manager limited to Polanco (gerente de sucursal)
    const ger = await call('POST', '/users', { name: 'Gerente', email: 'gerente@test.mx', password: 'password123', role: 'admin', locationId: pol.id }, tok);
    expect(ger.body).toMatchObject({ role: 'admin', locationId: pol.id, locationName: 'Polanco' });
    const gTok = (await call('POST', '/auth/login', { email: 'gerente@test.mx', password: 'password123' })).body.token;
    const range = `from=${encodeURIComponent(at.minus({ days: 3 }).toISO()!)}&to=${encodeURIComponent(at.plus({ days: 3 }).toISO()!)}`;
    const gList = (await call('GET', `/appointments?${range}`, undefined, gTok)).body;
    expect(gList.length).toBe(1);
    expect(gList[0].locationId).toBe(pol.id);
    expect((await call('GET', `/appointments?${range}`, undefined, tok)).body.length).toBe(2);
    expect((await call('GET', `/appointments/${apMain.id}`, undefined, gTok)).status).toBe(404);
    expect((await call('POST', '/appointments', { customerId: cust.id, serviceId: svc.id, resourceId: pMain.id, startsAt: at.plus({ hours: 2 }).toISO() }, gTok)).status).toBe(403);
    const gBook = await call('POST', '/appointments', { customerId: cust.id, serviceId: svc.id, startsAt: at.set({ hour: 16 }).toISO() }, gTok);
    expect(gBook.status).toBe(201);
    expect(gBook.body.locationId).toBe(pol.id);
    expect((await call('PATCH', '/tenant', { name: 'Hackeado' }, gTok)).status).toBe(403);
    expect((await call('POST', '/locations', { name: 'Otra' }, gTok)).status).toBe(403);
    expect((await call('POST', '/services', { name: 'X', durationMin: 30, priceCents: 1 }, gTok)).status).toBe(403);
    expect((await call('PUT', `/resources/${pMain.id}`, { name: 'Robado' }, gTok)).status).toBe(403);
    expect((await call('POST', '/users', { name: 'Otro', email: 'otro@test.mx', password: 'password123', role: 'staff', locationId: main.id }, gTok)).status).toBe(403);
    const gUsers = (await call('GET', '/users', undefined, gTok)).body as { email: string }[];
    expect(gUsers.map((u) => u.email)).toEqual(['gerente@test.mx']);
    // Reports split by location; the gerente only sees Polanco
    await call('PATCH', `/appointments/${apMain.id}`, { status: 'completed' }, tok);
    await call('PATCH', `/appointments/${gBook.body.id}`, { status: 'completed' }, tok);
    const from = DateTime.now().toISODate()!;
    const to = at.plus({ days: 1 }).toISODate()!;
    const rep = (await call('GET', `/reports?from=${from}&to=${to}`, undefined, tok)).body;
    expect(rep.byLocation.map((x: { name: string }) => x.name).sort()).toEqual(['Polanco', 'Principal']);
    const gRep = (await call('GET', `/reports?from=${from}&to=${to}`, undefined, gTok)).body;
    expect(gRep.byLocation.map((x: { name: string }) => x.name)).toEqual(['Polanco']);
    // Can't close a location with upcoming bookings
    expect((await call('PUT', `/locations/${pol.id}`, { name: 'Polanco', active: false }, tok)).body.error).toBe('location_has_bookings');

    // Someone who already has an account elsewhere joins with their own password
    const shared = await call('POST', '/users', { name: 'Owner B', email: 'owner-b@test.mx', password: 'whatever123', role: 'staff' }, tok);
    expect(shared.status).toBe(201);
    expect(shared.body.sharedAccount).toBe(true);
    expect((await call('PATCH', `/users/${shared.body.id}`, { password: 'hijacked123' }, tok)).body.error).toBe('shared_account');
    const bLogin = (await call('POST', '/auth/login', { email: 'owner-b@test.mx', password: 'password123' })).body;
    expect(bLogin.businesses).toHaveLength(2);
    // Removing them here keeps their account and their own business
    expect((await call('DELETE', `/users/${shared.body.id}`, undefined, tok)).status).toBe(204);
    expect((await call('POST', '/auth/login', { email: 'owner-b@test.mx', password: 'password123' })).body.businesses).toHaveLength(1);
  });

  it('password reset by email and login throttling', async () => {
    const { sentInTests } = await import('../src/lib/email.js');
    const reg = await call('POST', '/auth/register', {
      businessName: 'Reset Prueba', businessType: 'nutrition', name: 'Rita', email: 'rita@test.mx', password: 'password123',
    });
    expect(reg.status).toBe(201);
    const oldTok = reg.body.token;

    // Same answer for known and unknown emails; only the real account gets a link
    sentInTests.length = 0;
    expect((await call('POST', '/auth/forgot-password', { email: 'nadie@test.mx' })).body).toEqual({ ok: true });
    expect(sentInTests).toHaveLength(0);
    expect((await call('POST', '/auth/forgot-password', { email: 'RITA@test.mx' })).body).toEqual({ ok: true });
    expect(sentInTests).toHaveLength(1);
    expect(sentInTests[0]!.to).toBe('rita@test.mx');
    const token = /token=([A-Za-z0-9_-]+)/.exec(sentInTests[0]!.text)![1]!;
    // Demo logins never get a reset email
    await call('POST', '/auth/forgot-password', { email: 'demo@agenda.mx' });
    await call('POST', '/auth/forgot-password', { email: 'demo@lugali.com' });
    expect(sentInTests).toHaveLength(1);

    expect((await call('POST', '/auth/reset-password', { token: 'x'.repeat(43), password: 'nueva-clave-1' })).body.error).toBe('invalid_reset_token');
    expect((await call('POST', '/auth/reset-password', { token, password: 'corta' })).status).toBe(422);
    // Tokens carry whole seconds: wait so the old session is clearly older than the change
    await new Promise((r) => setTimeout(r, 1100));
    expect((await call('POST', '/auth/reset-password', { token, password: 'nueva-clave-1' })).status).toBe(200);
    // One use only; old sessions are signed out; old password stops working
    expect((await call('POST', '/auth/reset-password', { token, password: 'otra-clave-22' })).body.error).toBe('invalid_reset_token');
    expect((await call('GET', '/auth/me', undefined, oldTok)).status).toBe(401);
    expect((await call('POST', '/auth/login', { email: 'rita@test.mx', password: 'password123' })).status).toBe(401);
    const fresh = await call('POST', '/auth/login', { email: 'rita@test.mx', password: 'nueva-clave-1' });
    expect(fresh.status).toBe(200);
    expect((await call('GET', '/auth/me', undefined, fresh.body.token)).status).toBe(200);

    // Three requests per hour per email
    await call('POST', '/auth/forgot-password', { email: 'rita@test.mx' });
    await call('POST', '/auth/forgot-password', { email: 'rita@test.mx' });
    expect((await call('POST', '/auth/forgot-password', { email: 'rita@test.mx' })).status).toBe(429);

    // Five wrong passwords lock that email from this device for 15 minutes, even with the right one
    for (let i = 0; i < 5; i++) {
      expect((await call('POST', '/auth/login', { email: 'rita@test.mx', password: `mal-${i}` })).status).toBe(401);
    }
    const locked = await call('POST', '/auth/login', { email: 'rita@test.mx', password: 'nueva-clave-1' });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe('too_many_attempts');
    // Other people keep signing in normally
    expect((await call('POST', '/auth/login', { email: 'equipo@test.mx', password: 'password123' })).status).toBe(200);
  });

  it('schedules: own hours per person, split hours, blocked times, notes, rating and Spanish order', async () => {
    const reg = await call('POST', '/auth/register', {
      businessName: 'Horarios Prueba', businessType: 'barbershop', name: 'Dueña', email: 'horarios@test.mx', password: 'password123',
    });
    const tok = reg.body.token;
    const slug = 'horarios-prueba';
    const corte = (await call('POST', '/services', { name: 'Corte', durationMin: 60, priceCents: 20000 }, tok)).body;
    // Next Monday, so Mario (Mon–Sat) works and Ramiro (Tue–Sun) doesn't
    let monday = DateTime.now().setZone('America/Mexico_City').plus({ days: 7 }).startOf('day');
    while (monday.weekday !== 1) monday = monday.plus({ days: 1 });
    const tuesday = monday.plus({ days: 1 });
    const at = (d: DateTime, h: number, m = 0) => d.set({ hour: h, minute: m }).toISO()!;
    const slots = async (d: DateTime, pro?: string) =>
      (await call('GET', `/public/${slug}/availability?serviceId=${corte.id}&date=${d.toISODate()}${pro ? `&resourceId=${pro}` : ''}`)).body.slots as string[];

    const mario = (await call('POST', '/resources', { name: 'Mario', hours: { days: [1, 2, 3, 4, 5, 6], open: '08:00', close: '17:00' } }, tok)).body;
    expect(mario.hours).toEqual({ days: [1, 2, 3, 4, 5, 6], open: '08:00', close: '17:00' });
    const ramiro = (await call('POST', '/resources', { name: 'Ramiro', hours: { days: [2, 3, 4, 5, 6, 7], open: '10:00', close: '20:00' } }, tok)).body;
    // Saving other fields keeps the hours
    expect((await call('PUT', `/resources/${mario.id}`, { name: 'Mario' }, tok)).body.hours.open).toBe('08:00');

    // Monday: only Mario, 8:00–17:00 (outside the business 9–19 is fine: the person's hours rule)
    const mon = await slots(monday);
    expect(mon[0]).toBe(at(monday, 8));
    expect(mon).toContain(at(monday, 16));
    expect(mon).not.toContain(at(monday, 16, 30)); // a 60-min cut wouldn't end by 17:00
    expect(await slots(monday, ramiro.id)).toEqual([]);
    // Tuesday: Mario 8–17 plus Ramiro 10–20
    const tue = await slots(tuesday);
    expect(tue).toContain(at(tuesday, 8));
    expect(tue).toContain(at(tuesday, 19));
    expect(await slots(tuesday, mario.id)).not.toContain(at(tuesday, 19));
    // Staff can't put Ramiro on his day off
    const cust = (await call('POST', '/customers', { name: 'Ángel Ruiz', phone: '5544440001' }, tok)).body;
    const off = await call('POST', '/appointments', { customerId: cust.id, serviceId: corte.id, resourceId: ramiro.id, startsAt: at(monday, 11) }, tok);
    expect(off.status).toBe(409);

    // Split hours on Mario: 8–14 and 16–17
    await call('PUT', `/resources/${mario.id}`, { name: 'Mario', hours: { days: [1, 2, 3, 4, 5, 6], open: '08:00', close: '17:00', breaks: [{ start: '14:00', end: '16:00' }] } }, tok);
    const split = await slots(monday);
    expect(split).toContain(at(monday, 13));
    expect(split).not.toContain(at(monday, 13, 30));
    expect(split).not.toContain(at(monday, 14));
    expect(split).toContain(at(monday, 16));

    // Business with a break and no resources: a second business keeps it simple
    const solo = await call('POST', '/auth/register', {
      businessName: 'Consultorio Quebrado', businessType: 'nutrition', name: 'Dra', email: 'quebrado@test.mx', password: 'password123',
    });
    const me = (await call('GET', '/auth/me', undefined, solo.body.token)).body;
    const consulta = (await call('POST', '/services', { name: 'Consulta', durationMin: 60, priceCents: 50000 }, solo.body.token)).body;
    const hours = { days: [1, 2, 3, 4, 5], open: '08:00', close: '18:00', slotMinutes: 60, breaks: [{ start: '14:00', end: '16:00' }] };
    expect((await call('PATCH', '/tenant', { settings: { ...me.tenant.settings, hours } }, solo.body.token)).status).toBe(200);
    const soloSlots = (await call('GET', `/public/consultorio-quebrado/availability?serviceId=${consulta.id}&date=${monday.toISODate()}`)).body.slots as string[];
    expect(soloSlots.map((x) => DateTime.fromISO(x).setZone('America/Mexico_City').hour)).toEqual([8, 9, 10, 11, 12, 13, 16, 17]);

    // Blocked times: Mario's vacation Tuesday, then the whole business Wednesday morning
    const vac = await call('POST', '/time-blocks', { resourceId: mario.id, startsAt: tuesday.toISO(), endsAt: tuesday.plus({ days: 1 }).toISO(), reason: 'Vacaciones' }, tok);
    expect(vac.status).toBe(201);
    expect(await slots(tuesday, mario.id)).toEqual([]);
    expect(await slots(tuesday)).toContain(at(tuesday, 10)); // Ramiro still works
    const wed = tuesday.plus({ days: 1 });
    const closed = await call('POST', '/time-blocks', { startsAt: at(wed, 0), endsAt: at(wed, 13), reason: 'Junta' }, tok);
    expect(closed.status).toBe(201);
    const wedSlots = await slots(wed);
    expect(wedSlots.every((x) => DateTime.fromISO(x).setZone('America/Mexico_City').hour >= 13)).toBe(true);
    const blockedStaff = await call('POST', '/appointments', { customerId: cust.id, serviceId: corte.id, startsAt: at(wed, 10) }, tok);
    expect(blockedStaff.status).toBe(409);
    expect((await call('POST', `/public/${slug}/bookings`, { serviceId: corte.id, startsAt: at(wed, 10), name: 'Bloqueo', phone: '5544440009' })).status).toBe(409);
    const listed = await call('GET', `/time-blocks?from=${encodeURIComponent(monday.toISO()!)}&to=${encodeURIComponent(monday.plus({ days: 7 }).toISO()!)}`, undefined, tok);
    expect(listed.body.map((b: { reason: string }) => b.reason)).toEqual(['Vacaciones', 'Junta']);
    expect((await call('POST', '/time-blocks', { startsAt: at(wed, 13), endsAt: at(wed, 12) }, tok)).status).toBe(422);
    // Another business can't touch it; unblocking frees the time
    expect((await call('DELETE', `/time-blocks/${closed.body.id}`, undefined, solo.body.token)).status).toBe(404);
    expect((await call('DELETE', `/time-blocks/${closed.body.id}`, undefined, tok)).status).toBe(204);
    expect(await slots(wed)).toContain(at(wed, 10));

    // Notes and rating per booking; average on the customer
    const a1 = (await call('POST', '/appointments', { customerId: cust.id, serviceId: corte.id, startsAt: at(wed, 10) }, tok)).body;
    const a2 = (await call('POST', '/appointments', { customerId: cust.id, serviceId: corte.id, startsAt: at(wed, 12) }, tok)).body;
    const rated = await call('PATCH', `/appointments/${a1.id}`, { notes: 'Prefiere tijera', rating: 5 }, tok);
    expect(rated.body.notes).toBe('Prefiere tijera');
    expect(rated.body.rating).toBe(5);
    await call('PATCH', `/appointments/${a2.id}`, { rating: 4 }, tok);
    expect((await call('PATCH', `/appointments/${a2.id}`, { rating: 6 }, tok)).status).toBe(422);
    const detail = (await call('GET', `/customers/${cust.id}`, undefined, tok)).body;
    expect(detail.avgRating).toBe(4.5);
    expect(detail.ratingCount).toBe(2);
    expect(detail.appointments.find((x: { id: string }) => x.id === a1.id).rating).toBe(5);
    // Clearing a rating
    await call('PATCH', `/appointments/${a2.id}`, { rating: null }, tok);
    expect((await call('GET', `/customers/${cust.id}`, undefined, tok)).body.avgRating).toBe(5);

    // Accented names sort with their letter; headers flip the order
    for (const [name, phone] of [['Beto Díaz', '5544440002'], ['Ana López', '5544440003'], ['Óscar Peña', '5544440004'], ['Zoe Ortiz', '5544440005']]) {
      await call('POST', '/customers', { name, phone }, tok);
    }
    const names = async (q: string) => (await call('GET', `/customers?${q}`, undefined, tok)).body.items.map((c: { name: string }) => c.name);
    expect(await names('sort=name')).toEqual(['Ana López', 'Ángel Ruiz', 'Beto Díaz', 'Óscar Peña', 'Zoe Ortiz']);
    expect(await names('sort=name&dir=desc')).toEqual(['Zoe Ortiz', 'Óscar Peña', 'Beto Díaz', 'Ángel Ruiz', 'Ana López']);
    expect((await names('sort=rating'))[0]).toBe('Ángel Ruiz');
    expect((await call('GET', '/customers?sort=nope', undefined, tok)).status).toBe(200);

    // Photo uploads: only managers, only pictures, and a clear error until storage is connected
    const upload = async (file: File | null, token: string) => {
      const form = new FormData();
      if (file) form.append('file', file);
      const res = await app.request('/api/uploads/photo', { method: 'POST', body: form, headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: (await res.json()) as { error?: string } };
    };
    expect((await upload(null, tok)).status).toBe(422);
    expect((await upload(new File(['hola'], 'a.txt', { type: 'text/plain' }), tok)).body.error).toBe('unsupported_image');
    const prevBlob = process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    expect((await upload(new File([new Uint8Array([0xff, 0xd8, 0xff])], 'a.jpg', { type: 'image/jpeg' }), tok)).body.error).toBe('uploads_not_configured');
    if (prevBlob) process.env.BLOB_READ_WRITE_TOKEN = prevBlob;

    // Photos: validated before touching storage
    expect((await call('POST', '/resources', { name: 'Foto mala', photoUrl: 'http://inseguro.mx/a.jpg' }, tok)).status).toBe(422);
    const ok = await call('PUT', `/services/${corte.id}`, { name: 'Corte', durationMin: 60, priceCents: 20000, photoUrl: 'https://example.com/corte.jpg' }, tok);
    expect(ok.body.photoUrl).toBe('https://example.com/corte.jpg');
    expect((await call('GET', `/public/${slug}`)).body.services[0].photoUrl).toBe('https://example.com/corte.jpg');
  });

  it('payments: location and service per payment, all my businesses; status can be undone', async () => {
    const reg = (await call('POST', '/auth/register', {
      businessName: 'Pagos Uno', businessType: 'barbershop', name: 'Dueño Pagos', email: 'pagos@test.mx', password: 'password123',
    })).body;
    const tok = reg.token;
    const svc = (await call('POST', '/services', { name: 'Corte Pagos', durationMin: 30, priceCents: 20000 }, tok)).body;
    const cust = (await call('POST', '/customers', { name: 'Cliente Pagos', phone: '5577770001' }, tok)).body;
    let day = DateTime.now().setZone('America/Mexico_City').plus({ days: 3 });
    while (day.weekday === 7) day = day.plus({ days: 1 });
    const appt = (await call('POST', '/appointments', { customerId: cust.id, serviceId: svc.id, startsAt: day.set({ hour: 10, minute: 0 }).toISO() }, tok)).body;
    expect((await call('POST', '/payments', { customerId: cust.id, appointmentId: appt.id, amountCents: 5000, method: 'cash' }, tok)).status).toBe(201);
    expect((await call('POST', '/payments', { customerId: cust.id, amountCents: 3000, method: 'card' }, tok)).status).toBe(201);

    const range = `from=${encodeURIComponent(DateTime.now().minus({ days: 1 }).toISO()!)}&to=${encodeURIComponent(DateTime.now().plus({ days: 1 }).toISO()!)}`;
    const mine = (await call('GET', `/payments?${range}`, undefined, tok)).body;
    expect(mine).toHaveLength(2);
    const linked = mine.find((p: { appointmentId: string | null }) => p.appointmentId === appt.id);
    expect(linked.serviceName).toBe('Corte Pagos');
    expect(linked.locationName).toBeTruthy();
    expect(linked.businessName).toBe('Pagos Uno');
    expect(mine.find((p: { appointmentId: string | null }) => !p.appointmentId).locationId).toBeNull();

    // A second business: "all" lists both, the default stays on the current one
    const second = (await call('POST', '/businesses', { businessName: 'Pagos Dos', businessType: 'restaurant' }, tok)).body;
    const tok2 = second.token;
    const cust2 = (await call('POST', '/customers', { name: 'Cliente Dos', phone: '5577770002' }, tok2)).body;
    await call('POST', '/payments', { customerId: cust2.id, amountCents: 7000, method: 'transfer' }, tok2);
    expect((await call('GET', `/payments?${range}`, undefined, tok2)).body).toHaveLength(1);
    const all = (await call('GET', `/payments?${range}&all=1`, undefined, tok2)).body;
    expect(all.map((p: { businessName: string }) => p.businessName).sort()).toEqual(['Pagos Dos', 'Pagos Uno', 'Pagos Uno']);
    // Someone else's login never sees these, even asking for all
    const other = (await call('POST', '/auth/register', { businessName: 'Ajeno Pagos', businessType: 'spa', name: 'Ajeno', email: 'ajeno-pagos@test.mx', password: 'password123' })).body;
    expect((await call('GET', `/payments?${range}&all=1`, undefined, other.token)).body).toHaveLength(0);

    // "No asistió" by mistake goes back to "Confirmada"
    expect((await call('PATCH', `/appointments/${appt.id}`, { status: 'no_show' }, tok)).body.status).toBe('no_show');
    const back = await call('PATCH', `/appointments/${appt.id}`, { status: 'confirmed' }, tok);
    expect(back.status).toBe(200);
    expect(back.body.status).toBe('confirmed');
  });

  it('collections: every booking with its money state; Mercado Pago is never entered by hand', async () => {
    const reg = (await call('POST', '/auth/register', {
      businessName: 'Cobros Prueba', businessType: 'nutrition', name: 'Dra Cobros', email: 'cobros@test.mx', password: 'password123',
    })).body;
    const tok = reg.token;
    const svc = (await call('POST', '/services', { name: 'Consulta', durationMin: 60, priceCents: 50000 }, tok)).body;
    const cust = (await call('POST', '/customers', { name: 'Paciente Cobros', phone: '5588880001' }, tok)).body;
    const now = DateTime.now().setZone('America/Mexico_City');
    const book = async (d: DateTime) =>
      (await call('POST', '/appointments', { customerId: cust.id, serviceId: svc.id, startsAt: d.toISO(), allowOverlap: true }, tok)).body;
    const pay = (appointmentId: string, amountCents: number) =>
      call('POST', '/payments', { customerId: cust.id, appointmentId, amountCents, method: 'cash' }, tok);
    const future = now.plus({ days: 2 }).set({ hour: 10, minute: 0 });
    const past = now.minus({ days: 2 }).set({ hour: 10, minute: 0 });
    const fu = await book(future);
    const fd = await book(future.plus({ hours: 1 }));
    const fp = await book(future.plus({ hours: 2 }));
    const pu = await book(past);
    const pd = await book(past.plus({ hours: 1 }));
    const pp = await book(past.plus({ hours: 2 }));
    const ns = await book(past.plus({ hours: 3 }));
    const cancelled = await book(past.plus({ hours: 4 }));
    await pay(fd.id, 20000);
    await pay(fp.id, 50000);
    await pay(pd.id, 20000);
    await pay(pp.id, 50000);
    await call('PATCH', `/appointments/${ns.id}`, { status: 'no_show' }, tok);
    await call('PATCH', `/appointments/${cancelled.id}`, { status: 'cancelled' }, tok);

    const range = `from=${encodeURIComponent(now.minus({ days: 7 }).toISO()!)}&to=${encodeURIComponent(now.plus({ days: 7 }).toISO()!)}`;
    const rows = (await call('GET', `/collections?${range}`, undefined, tok)).body as { appointmentId: string; state: string; balanceCents: number; paidCents: number; methods: string[] }[];
    const st = (id: string) => rows.find((r) => r.appointmentId === id);
    expect(st(fu.id)?.state).toBe('upcoming_unpaid');
    expect(st(fd.id)?.state).toBe('upcoming_deposit');
    expect(st(fd.id)?.balanceCents).toBe(30000);
    expect(st(fp.id)?.state).toBe('upcoming_paid');
    expect(st(pu.id)?.state).toBe('past_unpaid');
    expect(st(pd.id)?.state).toBe('past_partial');
    expect(st(pp.id)?.state).toBe('past_paid');
    expect(st(pp.id)?.methods).toEqual(['cash']);
    expect(st(ns.id)?.state).toBe('past_unpaid'); // a no-show owes by default
    expect(st(cancelled.id)).toBeUndefined(); // cancelled without money: nothing to collect

    // The business decides no-shows aren't charged
    const me = (await call('GET', '/auth/me', undefined, tok)).body;
    await call('PATCH', '/tenant', { settings: { ...me.tenant.settings, payments: { ...me.tenant.settings.payments, noShowOwes: false } } }, tok);
    const rows2 = (await call('GET', `/collections?${range}`, undefined, tok)).body as { appointmentId: string }[];
    expect(rows2.find((r) => r.appointmentId === ns.id)).toBeUndefined();

    // Mercado Pago is recorded by the platform only
    const manualMp = await call('POST', '/payments', { customerId: cust.id, appointmentId: fu.id, amountCents: 100, method: 'mercadopago' }, tok);
    expect(manualMp.status).toBe(422);
    expect(manualMp.body.error).toBe('online_method_manual');
    expect((await call('POST', '/payments', { customerId: cust.id, appointmentId: fu.id, amountCents: 100, method: 'spei' }, tok)).status).toBe(422);
    expect((await call('GET', '/collections', undefined, tok)).status).toBe(422);
    // Another business sees none of it
    const other = (await call('POST', '/auth/register', { businessName: 'Otro Cobros', businessType: 'spa', name: 'Otro', email: 'otro-cobros@test.mx', password: 'password123' })).body;
    expect((await call('GET', `/collections?${range}&all=1`, undefined, other.token)).body).toHaveLength(0);
  });

  it('promotions: reward every N visits, coupons, availability check', async () => {
    const reg = (await call('POST', '/auth/register', {
      businessName: 'Promos Prueba', businessType: 'barbershop', name: 'Dueño Promos', email: 'promos@test.mx', password: 'password123',
    })).body;
    const tok = reg.token;
    const svc = (await call('POST', '/services', { name: 'Corte', durationMin: 30, priceCents: 20000 }, tok)).body;
    const cust = (await call('POST', '/customers', { name: 'Cliente Frecuente', phone: '5588880011' }, tok)).body;
    const now = DateTime.now().setZone('America/Mexico_City');
    const book = async (d: DateTime, extra: Record<string, unknown> = {}) =>
      call('POST', '/appointments', { customerId: cust.id, serviceId: svc.id, startsAt: d.toISO(), allowOverlap: true, ...extra }, tok);
    // Two finished visits
    for (const k of [10, 9]) {
      const a = (await book(now.minus({ days: k }).set({ hour: 10, minute: 0 }))).body;
      await call('PATCH', `/appointments/${a.id}`, { status: 'completed' }, tok);
    }
    // Off by default: no discount
    expect((await book(now.plus({ days: 1 }).set({ hour: 10, minute: 0 }))).body.discountCents).toBe(0);

    const me = (await call('GET', '/auth/me', undefined, tok)).body;
    await call('PATCH', '/tenant', { settings: { ...me.tenant.settings, rewards: { enabled: true, everyVisits: 2, discountType: 'percent', value: 10 }, coupons: { enabled: true } } }, tok);
    const preview = (await call('POST', '/appointments/discount', { customerId: cust.id, priceCents: 20000 }, tok)).body;
    expect(preview).toMatchObject({ discountCents: 2000, reason: 'reward', reward: { visitsSince: 2, eligible: true } });
    const rewarded = (await book(now.plus({ days: 2 }).set({ hour: 10, minute: 0 }))).body;
    expect(rewarded).toMatchObject({ priceCents: 18000, discountCents: 2000, discountReason: 'reward' });
    // Not given twice while it's waiting on an upcoming booking
    expect((await book(now.plus({ days: 3 }).set({ hour: 10, minute: 0 }))).body.discountCents).toBe(0);

    // Coupons: the better discount wins, uses are counted, bad codes are refused
    const coupon = await call('POST', '/coupons', { code: 'verano50', discountType: 'amount', value: 5000, maxUses: 1 }, tok);
    expect(coupon.status).toBe(201);
    expect(coupon.body.code).toBe('VERANO50');
    expect((await call('POST', '/coupons', { code: 'VERANO50', discountType: 'percent', value: 5 }, tok)).status).toBe(409);
    const withCoupon = (await book(now.plus({ days: 4 }).set({ hour: 10, minute: 0 }), { couponCode: 'Verano50' })).body;
    expect(withCoupon).toMatchObject({ priceCents: 15000, discountCents: 5000, discountReason: 'coupon', couponCode: 'VERANO50' });
    expect((await book(now.plus({ days: 5 }).set({ hour: 10, minute: 0 }), { couponCode: 'VERANO50' })).status).toBe(422); // used up
    expect((await book(now.plus({ days: 5 }).set({ hour: 10, minute: 0 }), { couponCode: 'NOEXISTE' })).body.error).toBe('coupon_invalid');
    const list = (await call('GET', '/coupons', undefined, tok)).body;
    expect(list[0].uses).toBe(1);
    const soft = (await call('POST', '/appointments/discount', { couponCode: 'NOEXISTE', priceCents: 20000 }, tok)).body;
    expect(soft.couponError).toBe('coupon_invalid');

    // Public page shows the promos and checks codes
    const slug = me.tenant.slug;
    const pub = (await call('GET', `/public/${slug}`)).body;
    expect(pub.promos).toMatchObject({ coupons: true, reward: { everyVisits: 2 } });
    await call('PUT', `/coupons/${coupon.body.id}`, { code: 'VERANO50', discountType: 'amount', value: 5000, maxUses: null }, tok);
    expect((await call('GET', `/public/${slug}/coupons/verano50`)).body).toMatchObject({ code: 'VERANO50', value: 5000 });
    expect((await call('GET', `/public/${slug}/coupons/nada`)).status).toBe(422);

    // Availability check before saving: a taken time answers with nearby free times
    const at = now.plus({ days: 6 }).set({ hour: 11, minute: 0 });
    await call('POST', '/appointments', { customerId: cust.id, serviceId: svc.id, startsAt: at.toISO() }, tok);
    const free = (await call('POST', '/appointments/check', { serviceId: svc.id, startsAt: at.plus({ hours: 2 }).toISO() }, tok)).body;
    expect(free.free).toBe(true);
    const taken = (await call('POST', '/appointments/check', { serviceId: svc.id, startsAt: at.toISO() }, tok)).body;
    expect(taken.free).toBe(false);
    expect(taken.times.length).toBeGreaterThan(0);
  });

  it('packages, memberships, gift cards, cash closing and commissions', async () => {
    const reg = (await call('POST', '/auth/register', {
      businessName: 'Ventas Prueba', businessType: 'barbershop', name: 'Dueña Ventas', email: 'ventas@test.mx', password: 'password123',
    })).body;
    const tok = reg.token;
    const svc = (await call('POST', '/services', { name: 'Corte', durationMin: 30, priceCents: 20000 }, tok)).body;
    const other = (await call('POST', '/services', { name: 'Tinte', durationMin: 60, priceCents: 50000 }, tok)).body;
    const ana = (await call('POST', '/resources', { name: 'Ana' }, tok)).body;
    const cust = (await call('POST', '/customers', { name: 'Cliente Paquete', phone: '5588880021' }, tok)).body;

    // Free plan: no packages, records or cash
    await call('PUT', '/tenant/plan', { plan: 'free' }, tok);
    expect((await call('POST', '/offerings', { kind: 'package', name: '5 cortes', priceCents: 80000, sessions: 5, validityDays: 60, serviceIds: [svc.id] }, tok)).status).toBe(402);
    expect((await call('GET', '/cash/summary?day=2026-11-01', undefined, tok)).status).toBe(402);
    expect((await call('PUT', '/tenant/plan', { plan: 'standard' }, tok)).status).toBe(200);

    const pack = (await call('POST', '/offerings', { kind: 'package', name: '5 cortes', priceCents: 80000, sessions: 5, validityDays: 60, serviceIds: [svc.id] }, tok)).body;
    const memb = (await call('POST', '/offerings', { kind: 'membership', name: 'Mensual ilimitado', priceCents: 120000, sessions: null }, tok)).body;
    expect((await call('POST', '/offerings', { kind: 'package', name: 'Sin sesiones', priceCents: 1000 }, tok)).status).toBe(422);
    expect((await call('POST', `/customers/${cust.id}/plans`, { offeringId: pack.id, method: 'cash' }, tok)).status).toBe(201);

    const now = DateTime.now().setZone('America/Mexico_City');
    const book = async (serviceId: string, h: number) =>
      (await call('POST', '/appointments', { customerId: cust.id, serviceId, resourceId: ana.id, startsAt: now.set({ hour: h, minute: 0 }).toISO(), allowOverlap: true }, tok)).body;
    const a1 = await book(svc.id, 9);
    // Choices only after "Asistió", and only plans that cover the service
    expect((await call('POST', `/appointments/${a1.id}/use-plan`, { planId: (await call('GET', `/appointments/${a1.id}/plans`, undefined, tok)).body.choices[0].id }, tok)).status).toBe(422);
    await call('PATCH', `/appointments/${a1.id}`, { status: 'completed' }, tok);
    const choices = (await call('GET', `/appointments/${a1.id}/plans`, undefined, tok)).body.choices;
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({ name: '5 cortes', sessionsLeft: 5 });
    expect((await call('POST', `/appointments/${a1.id}/use-plan`, { planId: choices[0].id }, tok)).status).toBe(200);
    const after = (await call('GET', `/appointments/${a1.id}`, undefined, tok)).body;
    expect(after).toMatchObject({ priceCents: 0, discountCents: 20000, discountReason: 'package' });
    let plans = (await call('GET', `/customers/${cust.id}/plans`, undefined, tok)).body.plans;
    expect(plans[0]).toMatchObject({ sessionsUsed: 1, sessionsLeft: 4, status: 'active' });
    expect(plans[0].uses).toHaveLength(1);
    const tint = await book(other.id, 11);
    await call('PATCH', `/appointments/${tint.id}`, { status: 'completed' }, tok);
    expect((await call('GET', `/appointments/${tint.id}/plans`, undefined, tok)).body.choices).toHaveLength(0);
    // Undoing "Asistió" gives the session back and the price
    await call('PATCH', `/appointments/${a1.id}`, { status: 'confirmed' }, tok);
    expect((await call('GET', `/appointments/${a1.id}`, undefined, tok)).body).toMatchObject({ priceCents: 20000, discountCents: 0 });
    plans = (await call('GET', `/customers/${cust.id}/plans`, undefined, tok)).body.plans;
    expect(plans[0].sessionsLeft).toBe(5);
    // Membership: unlimited sessions for any service
    await call('POST', `/customers/${cust.id}/plans`, { offeringId: memb.id, method: 'card' }, tok);
    expect((await call('GET', `/appointments/${tint.id}/plans`, undefined, tok)).body.choices[0]).toMatchObject({ name: 'Mensual ilimitado', sessionsLeft: null });

    // Gift card: sold to the customer, pays part of a booking, can't go below zero
    const gift = (await call('POST', '/gift-cards', { amountCents: 30000, method: 'cash', customerId: cust.id, recipientName: 'Mamá' }, tok)).body;
    expect(gift.code).toMatch(/^[A-Z2-9]{8}$/);
    const a2 = await book(svc.id, 13);
    expect((await call('POST', '/gift-cards/redeem', { code: gift.code.toLowerCase(), appointmentId: a2.id, amountCents: 20000 }, tok)).body.balanceCents).toBe(10000);
    expect((await call('POST', '/gift-cards/redeem', { code: gift.code, appointmentId: a2.id, amountCents: 20000 }, tok)).body.error).toBe('gift_card_balance');
    expect((await call('GET', `/gift-cards/${gift.code}`, undefined, tok)).body.balanceCents).toBe(10000);
    await call('POST', '/payments', { customerId: cust.id, appointmentId: tint.id, amountCents: 50000, method: 'cash' }, tok);

    // Cash closing: per method, sales of packages/memberships/gift cards, expected vs counted
    const day = now.toISODate();
    const sum = (await call('GET', `/cash/summary?day=${day}`, undefined, tok)).body;
    expect(sum.byMethod).toMatchObject({ cash: 80000 + 30000 + 50000, card: 120000, gift_card: 20000 });
    expect(sum.salesByKind).toMatchObject({ packages: 80000, memberships: 120000, giftCards: 30000 });
    expect(sum.expectedCashCents).toBe(160000);
    expect((await call('POST', '/cash/closings', { day, locationId: sum.locationId, countedCashCents: 159000, notes: 'Faltó cambio' }, tok)).status).toBe(201);
    const closings = (await call('GET', '/cash/closings', undefined, tok)).body;
    expect(closings[0]).toMatchObject({ differenceCents: -1000, closedByName: 'Dueña Ventas' });

    // Commissions: 40% general, 50% on Tinte; a package session counts at full price
    await call('PATCH', `/appointments/${a1.id}`, { status: 'completed' }, tok);
    await call('POST', `/appointments/${a1.id}/use-plan`, { planId: choices[0].id }, tok);
    expect((await call('PUT', `/resources/${ana.id}/commission`, { commissionPct: 40, commissionByService: { [other.id]: 50 } }, tok)).status).toBe(200);
    const rep = (await call('GET', `/reports/commissions?from=${day}&to=${day}`, undefined, tok)).body;
    expect(rep.rows[0]).toMatchObject({ resourceName: 'Ana', completed: 2, soldCents: 70000, commissionCents: 8000 + 25000 });

    // A team member sees only their commissions and can't do cash
    await call('POST', '/users', { name: 'Ana', email: 'ventas-ana@test.mx', password: 'password123', role: 'staff', resourceId: ana.id }, tok);
    const anaTok = (await call('POST', '/auth/login', { email: 'ventas-ana@test.mx', password: 'password123' })).body.token;
    expect((await call('GET', `/reports/commissions?from=${day}&to=${day}`, undefined, anaTok)).body.rows).toHaveLength(1);
    expect((await call('GET', `/cash/summary?day=${day}`, undefined, anaTok)).status).toBe(403);
    expect((await call('POST', `/customers/${cust.id}/plans`, { offeringId: pack.id, method: 'cash' }, anaTok)).status).toBe(403);
  });

  it('client record: encrypted, only for who may see it; photos need private storage', async () => {
    const reg = (await call('POST', '/auth/register', {
      businessName: 'Expediente Prueba', businessType: 'nutrition', name: 'Dra Exp', email: 'exp@test.mx', password: 'password123',
    })).body;
    const tok = reg.token;
    const cust = (await call('POST', '/customers', { name: 'Paciente Exp', phone: '5588880031' }, tok)).body;
    await call('PUT', '/tenant/plan', { plan: 'free' }, tok);
    expect((await call('GET', `/customers/${cust.id}/record`, undefined, tok)).status).toBe(402);
    await call('PUT', '/tenant/plan', { plan: 'standard' }, tok);
    expect((await call('PUT', `/customers/${cust.id}/record`, { allergies: 'Penicilina', conditions: 'Hipotiroidismo; levotiroxina', consent: true }, tok)).status).toBe(200);
    expect((await call('POST', `/customers/${cust.id}/record/notes`, { body: 'Plan bajo en sodio' }, tok)).status).toBe(201);
    const rec = (await call('GET', `/customers/${cust.id}/record`, undefined, tok)).body;
    expect(rec).toMatchObject({ allergies: 'Penicilina', consentByName: 'Dra Exp', photosEnabled: false });
    expect(rec.notes[0]).toMatchObject({ body: 'Plan bajo en sodio', authorName: 'Dra Exp' });
    // Encrypted at rest
    const { getDb } = await import('../src/db/client.js');
    const { sql } = await import('drizzle-orm');
    const raw = (await getDb().execute(sql`select allergies_enc, (select body_enc from record_notes where customer_id = ${cust.id} limit 1) as note from customer_records where customer_id = ${cust.id}`)).rows[0] as { allergies_enc: string; note: string };
    expect(raw.allergies_enc).not.toContain('Penicilina');
    expect(raw.note).not.toContain('sodio');
    // Team members: only for customers they attended; front desk none
    const svc = (await call('POST', '/services', { name: 'Consulta', durationMin: 30, priceCents: 50000 }, tok)).body;
    const r1 = (await call('POST', '/resources', { name: 'Nutrióloga Uno' }, tok)).body;
    await call('POST', '/resources', { name: 'Nutrióloga Dos' }, tok);
    await call('POST', '/users', { name: 'Uno', email: 'exp-uno@test.mx', password: 'password123', role: 'staff', resourceId: r1.id }, tok);
    const unoTok = (await call('POST', '/auth/login', { email: 'exp-uno@test.mx', password: 'password123' })).body.token;
    expect((await call('GET', `/customers/${cust.id}/record`, undefined, unoTok)).status).toBe(403);
    await call('POST', '/appointments', { customerId: cust.id, serviceId: svc.id, resourceId: r1.id, startsAt: DateTime.now().plus({ days: 1 }).toISO(), allowOverlap: true }, tok);
    expect((await call('GET', `/customers/${cust.id}/record`, undefined, unoTok)).status).toBe(200);
    // Photos: refused cleanly while the private store isn't connected
    const form = new FormData();
    form.append('file', new File([new Uint8Array([255, 216, 255])], 'a.jpg', { type: 'image/jpeg' }));
    const up = await app.request(`/api/customers/${cust.id}/record/photos`, { method: 'POST', body: form, headers: { authorization: `Bearer ${tok}` } });
    expect(up.status).toBe(502);
  });

  it('questionnaires: reusable per booking type, filled by the team in the appointment, kept in the record', async () => {
    const reg = (await call('POST', '/auth/register', {
      businessName: 'Cuestionario Prueba', businessType: 'nutrition', name: 'Dra Forms', email: 'forms@test.mx', password: 'password123',
    })).body;
    const tok = reg.token;
    const slug = reg.tenant.slug;
    const s1 = (await call('POST', '/services', { name: 'Primera vez', durationMin: 60, priceCents: 0 }, tok)).body;
    const s2 = (await call('POST', '/services', { name: 'Bioimpedancia', durationMin: 30, priceCents: 0 }, tok)).body;
    const s3 = (await call('POST', '/services', { name: 'Seguimiento', durationMin: 30, priceCents: 0 }, tok)).body;
    const body = {
      name: 'Historia clínica',
      fields: [
        { id: 'objetivo', label: 'Objetivo', type: 'choice', required: true, options: ['Bajar', 'Subir'] },
        { id: 'deporte', label: '¿Haces ejercicio?', type: 'yesno', required: false },
        { id: 'comidas', label: 'Comidas', type: 'multi', options: ['Desayuno', 'Comida', 'Cena'] },
      ],
      serviceIds: [s1.id, s2.id],
    };
    // Plan gate and validation
    await call('PUT', '/tenant/plan', { plan: 'free' }, tok);
    expect((await call('POST', '/forms', body, tok)).status).toBe(402);
    await call('PUT', '/tenant/plan', { plan: 'standard' }, tok);
    expect((await call('POST', '/forms', { ...body, fields: [{ id: 'xxxx', label: 'X', type: 'choice', options: ['solo'] }] }, tok)).status).toBe(422);
    const f = (await call('POST', '/forms', body, tok));
    expect(f.status).toBe(201);
    expect(f.body.serviceIds).toEqual([s1.id, s2.id]);

    // Booking online stays short: no questions on the public page, booking works without answers
    const pub = (await call('GET', '/public/' + slug)).body;
    expect(pub.forms).toBeUndefined();
    let day = DateTime.now().setZone('America/Mexico_City').plus({ days: 2 });
    while (day.weekday === 7) day = day.plus({ days: 1 });
    const slots = (await call('GET', `/public/${slug}/availability?serviceId=${s2.id}&date=${day.toISODate()}`)).body.slots;
    expect((await call('POST', `/public/${slug}/bookings`, { serviceId: s2.id, startsAt: slots[0], name: 'Paciente Forms', phone: '5577770001' })).status).toBe(201);

    const appts = (await call('GET', `/appointments?from=${encodeURIComponent(day.startOf('day').toISO()!)}&to=${encodeURIComponent(day.endOf('day').toISO()!)}`, undefined, tok)).body;
    const appt = appts.find((a: { customerName: string }) => a.customerName === 'Paciente Forms');
    // Reused on a second booking type: shows up pending in the appointment
    let af = (await call('GET', `/appointments/${appt.id}/forms`, undefined, tok)).body;
    expect(af).toHaveLength(1);
    expect(af[0]).toMatchObject({ form: { name: 'Historia clínica' }, response: null });
    // A booking type without the form has none
    const cu3 = (await call('POST', '/customers', { name: 'Otro Paciente', phone: '5577770002' }, tok)).body;
    const a3 = (await call('POST', '/appointments', { customerId: cu3.id, serviceId: s3.id, startsAt: DateTime.now().plus({ days: 4 }).toISO(), allowOverlap: true }, tok)).body;
    expect((await call('GET', `/appointments/${a3.id}/forms`, undefined, tok)).body).toEqual([]);

    // The team fills it: required answers enforced, choices validated
    expect((await call('POST', `/appointments/${appt.id}/forms`, { formId: f.body.id, values: { deporte: true } }, tok)).body.error).toBe('form_required');
    expect((await call('POST', `/appointments/${appt.id}/forms`, { formId: f.body.id, values: { objetivo: 'Otro' } }, tok)).body.error).toBe('form_invalid');
    const filled = await call('POST', `/appointments/${appt.id}/forms`, { formId: f.body.id, values: { objetivo: 'Bajar', deporte: true, comidas: ['Desayuno', 'Cena'] } }, tok);
    expect(filled.status).toBe(201);
    expect(filled.body).toMatchObject({ source: 'staff', authorName: 'Dra Forms' });
    expect(filled.body.answers.map((a: { value: unknown }) => a.value)).toEqual(['Bajar', true, ['Desayuno', 'Cena']]);
    // Correcting it keeps one response
    expect((await call('POST', `/appointments/${appt.id}/forms`, { formId: f.body.id, values: { objetivo: 'Subir' } }, tok)).status).toBe(201);
    af = (await call('GET', `/appointments/${appt.id}/forms`, undefined, tok)).body;
    expect(af[0].response.answers[0].value).toBe('Subir');
    const rec = (await call('GET', `/customers/${appt.customerId}/record`, undefined, tok)).body;
    expect(rec.responses).toHaveLength(1);
    expect(rec.responses[0]).toMatchObject({ formName: 'Historia clínica', serviceName: 'Bioimpedancia' });
    expect(rec.responses[0].answers[0]).toMatchObject({ label: 'Objetivo', value: 'Subir' });
    // Encrypted at rest
    const { getDb } = await import('../src/db/client.js');
    const { sql } = await import('drizzle-orm');
    const raw = (await getDb().execute(sql`select answers_enc from form_responses where customer_id = ${appt.customerId}`)).rows[0] as { answers_enc: string };
    expect(raw.answers_enc).not.toContain('Subir');
    // Team members who didn't attend can't see answers nor edit forms
    const ra = (await call('POST', '/resources', { name: 'Nutrióloga A' }, tok)).body;
    const rb = (await call('POST', '/resources', { name: 'Nutrióloga B' }, tok)).body;
    await call('POST', '/users', { name: 'Equipo', email: 'forms-rec@test.mx', password: 'password123', role: 'staff', resourceId: rb.id }, tok);
    const recTok = (await call('POST', '/auth/login', { email: 'forms-rec@test.mx', password: 'password123' })).body.token;
    const other = (await call('POST', '/customers', { name: 'Paciente de A', phone: '5577770009' }, tok)).body;
    const theirs = (await call('POST', '/appointments', { customerId: other.id, serviceId: s1.id, resourceId: ra.id, startsAt: DateTime.now().plus({ days: 3 }).toISO(), allowOverlap: true }, tok)).body;
    expect((await call('GET', `/appointments/${theirs.id}/forms`, undefined, recTok)).status).toBe(403);
    expect((await call('POST', `/appointments/${theirs.id}/forms`, { formId: f.body.id, values: { objetivo: 'Bajar' } }, recTok)).status).toBe(403);
    expect((await call('POST', '/forms', body, recTok)).status).toBe(403);
    // Listing shows the count; deleting the form keeps the answers
    expect((await call('GET', '/forms', undefined, tok)).body[0].responses).toBe(1);
    expect((await call('DELETE', `/forms/${f.body.id}`, undefined, tok)).status).toBe(204);
    expect((await call('GET', `/customers/${appt.customerId}/record`, undefined, tok)).body.responses[0].formName).toBe('Historia clínica');
  });

  it('"any available": least used, cheapest free or favorites, as the business chooses', async () => {
    const reg = (await call('POST', '/auth/register', {
      businessName: 'Canchas Regla', businessType: 'barbershop', name: 'Dueño Regla', email: 'regla@test.mx', password: 'password123',
    })).body;
    const tok = reg.token;
    const slug = reg.tenant.slug;
    const svc = (await call('POST', '/services', { name: 'Turno', durationMin: 60, priceCents: 40000 }, tok)).body;
    const cara = (await call('POST', '/resources', { name: 'A Central', pricePerHourCents: 55000, serviceIds: [svc.id] }, tok)).body;
    await call('POST', '/resources', { name: 'B Norte', pricePerHourCents: 45000, serviceIds: [svc.id] }, tok);
    await call('POST', '/resources', { name: 'C Sur', pricePerHourCents: 45000, serviceIds: [svc.id] }, tok);
    const setRule = async (assignment: unknown) => {
      const me = (await call('GET', '/auth/me', undefined, tok)).body;
      const r = await call('PATCH', '/tenant', { settings: { ...me.tenant.settings, assignment } }, tok);
      expect(r.status).toBe(200);
    };
    let day = DateTime.now().setZone('America/Mexico_City').plus({ days: 3 });
    while (day.weekday === 7) day = day.plus({ days: 1 });
    const slots = (await call('GET', `/public/${slug}/availability?serviceId=${svc.id}&date=${day.toISODate()}`)).body.slots as string[];
    const book = async (i: number) => (await call('POST', `/public/${slug}/bookings`, { serviceId: svc.id, resourceId: null, startsAt: slots[i], name: `Cliente ${i}`, phone: `55666600${10 + i}` })).body;
    // Default (least used, then name): A Central
    expect((await book(0)).resourceName).toBe('A Central');
    await setRule({ strategy: 'cheapest', preferredIds: [] });
    const cheap = await book(2);
    expect(['B Norte', 'C Sur']).toContain(cheap.resourceName);
    expect(cheap.priceCents).toBe(45000);
    await setRule({ strategy: 'preferred', preferredIds: [cara.id] });
    expect((await book(4)).resourceName).toBe('A Central');
  });

  it('sign in and sign up with Google (verified email only)', async () => {
    const { setGoogleVerifier } = await import('../src/lib/google.js');
    setGoogleVerifier(async (cred) => {
      if (cred === 'x'.repeat(20) + 'bad') throw new (await import('../src/lib/errors.js')).AppError(401, 'google_invalid');
      return { email: cred.slice(20).toLowerCase(), name: 'Google Person' };
    });
    expect((await call('GET', '/config')).body).toHaveProperty('googleClientId');
    // Existing account: same email logs in
    const ok = await call('POST', '/auth/google', { credential: 'x'.repeat(20) + 'owner-a@test.mx' });
    expect(ok.status).toBe(200);
    expect(ok.body.tenant.slug).toBe('negocio-a');
    expect((await call('POST', '/auth/google', { credential: 'x'.repeat(20) + 'bad' })).status).toBe(401);
    // New person: told to sign up, then signs up with the Google email (no password)
    const none = await call('POST', '/auth/google', { credential: 'x'.repeat(20) + 'nuevo-google@test.mx' });
    expect(none.status).toBe(404);
    expect(none.body).toMatchObject({ error: 'google_no_account', details: { email: 'nuevo-google@test.mx' } });
    const reg = await call('POST', '/auth/register', { businessName: 'Con Google', businessType: 'spa', name: 'Google Person', email: 'otro@test.mx', googleCredential: 'x'.repeat(20) + 'nuevo-google@test.mx' });
    expect(reg.status).toBe(201);
    expect(reg.body.user.email).toBe('nuevo-google@test.mx');
    expect((await call('POST', '/auth/google', { credential: 'x'.repeat(20) + 'nuevo-google@test.mx' })).status).toBe(200);
    // Without Google, a password is still required
    expect((await call('POST', '/auth/register', { businessName: 'Sin Clave', businessType: 'spa', name: 'Sin Clave', email: 'sinclave@test.mx' })).status).toBe(422);
    setGoogleVerifier(null);
  });

  it('online sales: package and gift card paid with Mercado Pago, created once when paid', async () => {
    const reg = (await call('POST', '/auth/register', {
      businessName: 'Venta Linea', businessType: 'yoga', name: 'Dueña Venta', email: 'venta@test.mx', password: 'password123',
    })).body;
    const tok = reg.token;
    const slug = reg.tenant.slug;
    const off = (await call('POST', '/offerings', { kind: 'package', name: 'Paquete 5 clases', priceCents: 50000, sessions: 5, validityDays: 30 }, tok)).body;
    // Not selling online yet: no shop
    expect((await call('GET', '/public/' + slug)).body.shop).toBeNull();
    const me = (await call('GET', '/auth/me', undefined, tok)).body;
    await call('PATCH', '/tenant', { settings: { ...me.tenant.settings, sales: { online: true, giftCardAmounts: [50000, 100000] } } }, tok);
    // Still hidden until Mercado Pago is connected (money goes to the business)
    expect((await call('GET', '/public/' + slug)).body.shop).toBeNull();
    const { getDb } = await import('../src/db/client.js');
    const { sql } = await import('drizzle-orm');
    const { encryptSecret } = await import('../src/lib/crypto.js');
    await getDb().execute(sql`update tenants set mp_access_token_enc = ${encryptSecret('TEST-MP-TOKEN')} where id = ${reg.tenant.id}`);
    const shop = (await call('GET', '/public/' + slug)).body.shop;
    expect(shop.offerings.map((o: { id: string }) => o.id)).toEqual([off.id]);
    expect(shop.giftCardAmounts).toEqual([50000, 100000]);

    // Mercado Pago, mocked: checkout links and payment status
    const realFetch = globalThis.fetch;
    const mpStatus = new Map<string, { status: string; ref: string }>();
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://api.mercadopago.com')) return realFetch(input, init);
      if (url.endsWith('/checkout/preferences')) {
        const body = JSON.parse(String(init?.body));
        sent.push({ url, body });
        return new Response(JSON.stringify({ id: `pref-${sent.length}`, init_point: `https://mp.test/checkout/${sent.length}` }), { status: 201 });
      }
      const m = /\/v1\/payments\/(\w+)$/.exec(url);
      const st = m ? mpStatus.get(m[1]!) : null;
      if (st) return new Response(JSON.stringify({ status: st.status, external_reference: st.ref }), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    try {
      expect((await call('POST', `/public/${slug}/purchases`, { kind: 'gift_card', amountCents: 12345, name: 'Comprador', phone: '5544332211' })).body.error).toBe('gift_card_amount');
      const buy = await call('POST', `/public/${slug}/purchases`, { kind: 'plan', offeringId: off.id, name: 'Comprador', phone: '5544332211', email: 'comprador@test.mx' });
      expect(buy.status).toBe(201);
      expect(buy.body.checkoutUrl).toBe('https://mp.test/checkout/1');
      expect(sent[0]!.body).toMatchObject({ items: [{ unit_price: 500, currency_id: 'MXN' }] });
      expect(String((sent[0]!.body.back_urls as { success: string }).success)).toContain(buy.body.purchasePath);
      const ptoken = buy.body.purchasePath.slice('/compra/'.length);
      expect((await call('GET', `/public/purchases/${ptoken}`)).body).toMatchObject({ status: 'pending', kind: 'plan', itemName: 'Paquete 5 clases', plan: null });
      expect((await call('GET', '/public/purchases/' + ptoken.slice(0, -2) + 'xx')).status).toBe(404);

      // Paid: the webhook creates the package once
      const payId = (sent[0]!.body.external_reference as string);
      mpStatus.set('901', { status: 'approved', ref: payId });
      for (let i = 0; i < 2; i++) {
        const w = await app.request(`/api/webhooks/mercadopago?tenant=${reg.tenant.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'payment', data: { id: '901' } }) });
        expect(w.status).toBe(200);
      }
      const st = (await call('GET', `/public/purchases/${ptoken}`)).body;
      expect(st).toMatchObject({ status: 'paid', plan: { sessionsLeft: 5 } });
      const cust = (await call('GET', `/customers?q=Comprador`, undefined, tok)).body.items[0];
      const plans = (await call('GET', `/customers/${cust.id}/plans`, undefined, tok)).body.plans;
      expect(plans).toHaveLength(1);
      expect(plans[0]).toMatchObject({ name: 'Paquete 5 clases', sessionsLeft: 5, status: 'active' });

      // Gift card for someone else
      const gift = await call('POST', `/public/${slug}/purchases`, { kind: 'gift_card', amountCents: 100000, recipientName: 'Mamá', name: 'Comprador', phone: '5544332211' });
      expect(gift.status).toBe(201);
      mpStatus.set('902', { status: 'approved', ref: sent[1]!.body.external_reference as string });
      await app.request(`/api/webhooks/mercadopago?tenant=${reg.tenant.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'payment', data: { id: '902' } }) });
      const gst = (await call('GET', `/public/purchases/${gift.body.purchasePath.slice(8)}`)).body;
      expect(gst).toMatchObject({ status: 'paid', kind: 'gift_card', recipientName: 'Mamá' });
      expect(gst.giftCardCode).toMatch(/^[A-Z0-9-]{6,}$/);
      const cards = (await call('GET', '/gift-cards', undefined, tok)).body;
      expect(cards.find((g: { code: string }) => g.code === gst.giftCardCode)).toMatchObject({ balanceCents: 100000, recipientName: 'Mamá' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('coupons: only some services and once per customer', async () => {
    const reg = (await call('POST', '/auth/register', {
      businessName: 'Cupon Reglas', businessType: 'nutrition', name: 'Dra Cupon', email: 'cupon-reglas@test.mx', password: 'password123',
    })).body;
    const tok = reg.token;
    const slug = reg.tenant.slug;
    const first = (await call('POST', '/services', { name: 'Consulta inicial', durationMin: 60, priceCents: 70000 }, tok)).body;
    const follow = (await call('POST', '/services', { name: 'Seguimiento', durationMin: 30, priceCents: 40000 }, tok)).body;
    const me = (await call('GET', '/auth/me', undefined, tok)).body;
    await call('PATCH', '/tenant', { settings: { ...me.tenant.settings, coupons: { enabled: true } } }, tok);
    const cp = await call('POST', '/coupons', { code: 'bienvenida', discountType: 'percent', value: 15, serviceIds: [first.id] }, tok);
    expect(cp.status).toBe(201);
    expect(cp.body).toMatchObject({ code: 'BIENVENIDA', serviceIds: [first.id], maxUsesPerCustomer: 1 });
    expect((await call('GET', `/public/${slug}/coupons/BIENVENIDA?serviceId=${follow.id}`)).body.error).toBe('coupon_not_for_service');
    expect((await call('GET', `/public/${slug}/coupons/BIENVENIDA?serviceId=${first.id}`)).status).toBe(200);
    let day = DateTime.now().setZone('America/Mexico_City').plus({ days: 2 });
    while (day.weekday === 7) day = day.plus({ days: 1 });
    const slotsF = (await call('GET', `/public/${slug}/availability?serviceId=${follow.id}&date=${day.toISODate()}`)).body.slots;
    const wrong = await call('POST', `/public/${slug}/bookings`, { serviceId: follow.id, startsAt: slotsF[0], name: 'Paciente Cupon', phone: '5521212121', couponCode: 'BIENVENIDA' });
    expect(wrong.body.error).toBe('coupon_not_for_service');
    const slots = (await call('GET', `/public/${slug}/availability?serviceId=${first.id}&date=${day.toISODate()}`)).body.slots;
    const ok = await call('POST', `/public/${slug}/bookings`, { serviceId: first.id, startsAt: slots[0], name: 'Paciente Cupon', phone: '5521212121', couponCode: 'BIENVENIDA' });
    expect(ok.status).toBe(201);
    expect(ok.body.discountCents).toBe(10500);
    // Same customer again: already used (the check with the phone says so too)
    expect((await call('GET', `/public/${slug}/coupons/BIENVENIDA?serviceId=${first.id}&phone=5521212121`)).body.error).toBe('coupon_already_used');
    const again = await call('POST', `/public/${slug}/bookings`, { serviceId: first.id, startsAt: slots[3], name: 'Paciente Cupon', phone: '5521212121', couponCode: 'BIENVENIDA' });
    expect(again.body.error).toBe('coupon_already_used');
    // Another customer can still use it; "no limit per customer" lifts the rule
    expect((await call('POST', `/public/${slug}/bookings`, { serviceId: first.id, startsAt: slots[5], name: 'Otra Paciente', phone: '5521212122', couponCode: 'BIENVENIDA' })).status).toBe(201);
    await call('PUT', `/coupons/${cp.body.id}`, { code: 'BIENVENIDA', discountType: 'percent', value: 15, serviceIds: [first.id], maxUsesPerCustomer: null }, tok);
    expect((await call('POST', `/public/${slug}/bookings`, { serviceId: first.id, startsAt: slots[7], name: 'Paciente Cupon', phone: '5521212121', couponCode: 'BIENVENIDA' })).status).toBe(201);
  });

  it('clinical catalogs: CIE-10 search and allergy check', async () => {
    const { searchCie10, allergyConflict, pregnancyFromFum } = await import('@agenda/shared');
    expect(searchCie10('diabetes tipo 2')[0]!.code).toMatch(/^E11/);
    expect(searchCie10('e119')[0]!.code).toBe('E11.9');
    expect(searchCie10('lumbalgia').map((x) => x.code)).toContain('M54.5');
    expect(allergyConflict('Penicilina', 'Amoxicilina 500 mg cápsulas')).toBe('penicilinas');
    expect(allergyConflict('Alérgico a sulfas', 'Trimetoprima/sulfametoxazol 160/800 mg')).toBe('sulfas');
    expect(allergyConflict('Niega alergias', 'Amoxicilina 500 mg')).toBeNull();
    expect(allergyConflict('Penicilina', 'Paracetamol 500 mg')).toBeNull();
    expect(pregnancyFromFum('2026-01-01', new Date('2026-03-01T12:00:00'))).toEqual({ sdg: '8.3', fpp: '2026-10-08' });
  });

  it('clinical extras: own templates, prescription check, sharing and patient portal', async () => {
    const { sentInTests } = await import('../src/lib/email.js');
    const reg = (await call('POST', '/auth/register', {
      businessName: 'Pediatria Portal', businessType: 'medical', name: 'Dr. Luis Paz', email: 'portal-doc@test.mx', password: 'password123',
    })).body;
    const tok = reg.token;
    await call('PATCH', '/auth/me', { professional: { license: '7654321' } }, tok);
    const pat = (await call('POST', '/customers', { name: 'Sofia Paciente', phone: '5577002200', email: 'sofia@correo.mx', birthday: '2020-02-02' }, tok)).body;
    await call('PUT', `/customers/${pat.id}/record`, { allergies: 'Penicilina' }, tok);
    expect((await call('GET', `/customers/${pat.id}/clinical`, undefined, tok)).body.patient.allergies).toContain('Penicilina');

    // Own template, saved in the settings, travels with the document
    const me = (await call('GET', '/auth/me', undefined, tok)).body.tenant.settings;
    const own = { id: 'custom_lactancia', title: 'Valoración de lactancia', kind: 'evolution', fields: [{ id: 'agarre', label: 'Agarre', type: 'select', options: ['Bueno', 'Malo'], required: true }, { id: 'nota', label: 'Nota', type: 'longtext' }] };
    expect((await call('PATCH', '/tenant', { settings: { ...me, clinicalTemplates: [own] } }, tok)).status).toBe(200);
    expect((await call('POST', `/customers/${pat.id}/clinical-notes`, { template: 'custom_otra', content: {} }, tok)).body.error).toBe('clinical_template');
    const ownNote = await call('POST', `/customers/${pat.id}/clinical-notes`, { template: 'custom_lactancia', content: {}, password: 'password123' }, tok);
    expect(ownNote.body.error).toBe('clinical_incomplete');
    const ownSigned = await call('POST', `/customers/${pat.id}/clinical-notes`, { template: 'custom_lactancia', content: { agarre: 'Bueno' }, password: 'password123' }, tok);
    expect(ownSigned.body).toMatchObject({ status: 'signed', title: 'Valoración de lactancia' });
    expect(ownSigned.body.content.__template.fields).toHaveLength(2);
    await call('PATCH', '/tenant', { settings: { ...me, clinicalTemplates: [] } }, tok);
    const still = (await call('GET', `/customers/${pat.id}/clinical`, undefined, tok)).body.notes.find((n: { id: string }) => n.id === ownSigned.body.id);
    expect(still.content.agarre).toBe('Bueno');

    // Pediatric and prenatal templates exist for doctors
    const ped = await call('POST', `/customers/${pat.id}/clinical-notes`, { template: 'pediatric_visit', content: { medidas: { peso: 14, talla: 95 } } }, tok);
    expect(ped.status).toBe(201);

    // Signed prescription: public check page and email to the patient
    const rx = await call('POST', `/customers/${pat.id}/clinical-notes`, {
      template: 'prescription', password: 'password123',
      content: { medicamentos: [{ name: 'Paracetamol 160 mg/5 ml', dose: '5 ml', route: 'Oral', frequency: 'Cada 8 h', duration: '3 días' }], indicaciones: 'Reposo', diagnostico: 'Faringitis' },
    }, tok);
    expect(rx.body.verifyPath).toMatch(/^\/receta\//);
    const rxToken = rx.body.verifyPath.split('/').pop();
    const check = await call('GET', `/public/prescriptions/${rxToken}`);
    expect(check.body).toMatchObject({ doctor: { license: '7654321' }, patient: { name: 'Sofia Paciente' } });
    expect(check.body.content.medicamentos[0].name).toContain('Paracetamol');
    expect((await call('GET', `/public/prescriptions/${rxToken.slice(0, -2)}xx`)).status).toBe(404);
    sentInTests.length = 0;
    expect((await call('POST', `/clinical-notes/${rx.body.id}/send`, undefined, tok)).status).toBe(200);
    expect(sentInTests[0]!.to).toBe('sofia@correo.mx');
    expect(sentInTests[0]!.text).toContain('/receta/');

    // Portal: link by email only for a known patient; shows only what was shared
    sentInTests.length = 0;
    await call('POST', `/public/${reg.tenant.slug}/portal/link`, { email: 'nadie@correo.mx' });
    expect(sentInTests).toHaveLength(0);
    expect((await call('POST', `/public/${reg.tenant.slug}/portal/link`, { email: 'SOFIA@correo.mx' })).body).toEqual({ ok: true });
    expect(sentInTests).toHaveLength(1);
    const pt = /\?t=([0-9a-f-]{36}\.\d{10}\.[A-Za-z0-9_-]{24})/.exec(sentInTests[0]!.text)![1]!;
    // Or the 6-digit code from the same email (another device)
    const code = /(\d{6})/.exec(sentInTests[0]!.subject)![1]!;
    expect((await call('POST', `/public/${reg.tenant.slug}/portal/code`, { email: 'sofia@correo.mx', code: code === '000000' ? '000001' : '000000' })).body.error).toBe('portal_bad_code');
    const byCode = await call('POST', `/public/${reg.tenant.slug}/portal/code`, { email: 'sofia@correo.mx', code });
    expect(byCode.body.token).toMatch(/^[0-9a-f-]{36}\.\d{10}\./);
    const portal = async (t: string) => {
      const res = await app.request('/api/public/portal', { headers: { 'x-portal-token': t } });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { status: res.status, body: (await res.json()) as any };
    };
    let p = await portal(pt);
    expect(p.status).toBe(200);
    expect(p.body.patient.name).toBe('Sofia Paciente');
    expect(p.body.renewedToken).toBeNull();
    expect(p.body.documents).toHaveLength(0);
    expect((await call('POST', `/clinical-notes/${ped.body.id}/share`, { shared: true }, tok)).body.error).toBe('clinical_draft');
    await call('POST', `/clinical-notes/${rx.body.id}/share`, { shared: true }, tok);
    p = await portal(pt);
    expect(p.body.documents.map((d: { id: string }) => d.id)).toEqual([rx.body.id]);
    await call('POST', `/clinical-notes/${rx.body.id}/share`, { shared: false }, tok);
    expect((await portal(pt)).body.documents).toHaveLength(0);
    expect((await portal(`${pt.slice(0, -2)}xx`)).status).toBe(401);
    // Studies need the private storage
    expect((await call('GET', `/customers/${pat.id}/clinical`, undefined, tok)).body.studiesEnabled).toBe(false);
  });

  it('CFDI invoicing with Facturapi (mocked): setup, CSD, invoice, files, cancel', async () => {
    const { setFacturapiFetch } = await import('../src/integrations/facturapi.js');
    const reg = (await call('POST', '/auth/register', { businessName: 'Factura Clinica', businessType: 'medical', name: 'Dra. Factura', email: 'cfdi@test.mx', password: 'password123' })).body;
    const tok = reg.token;
    const settings = { rfc: 'XEXX010101000', legalName: 'DRA FACTURA', taxSystem: '612', zip: '28000', series: 'F', productKey: '85121500', description: 'Consulta médica', iva: 'exento', autoEmail: false };
    // Platform without Facturapi: data is kept, nothing else
    delete process.env.FACTURAPI_USER_KEY;
    let st = await call('PUT', '/invoicing', settings, tok);
    expect(st.body).toMatchObject({ available: false, connected: false, settings: { rfc: 'XEXX010101000' } });
    expect((await call('PUT', '/invoicing', { ...settings, rfc: 'MAL' }, tok)).status).toBe(422);

    const calls: { method: string; path: string; auth: string; body: unknown }[] = [];
    setFacturapiFetch(async (url, init) => {
      const path = url.replace('https://www.facturapi.io/v2', '');
      const auth = String((init.headers as Record<string, string>).Authorization);
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body ? 'form' : undefined;
      calls.push({ method: String(init.method), path, auth, body });
      const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/organizations') return json({ id: 'org_1' });
      if (path.endsWith('/apikeys/test')) return json('sk_test_abc');
      if (path.endsWith('/apikeys/live')) return json('sk_live_abc');
      if (path.endsWith('/legal') || path.endsWith('/certificate')) return json({ ok: true });
      if (path === '/invoices' && init.method === 'POST') return json({ id: 'inv_1', uuid: 'AAAA-BBBB', series: 'F', folio_number: 7, total: 600, status: 'valid' });
      if (path === '/invoices/inv_1/pdf') return new Response('%PDF-1.4 test', { status: 200 });
      if (path === '/invoices/inv_1/email') return json({ ok: true });
      if (path.startsWith('/invoices/inv_1?motive=')) return json({ id: 'inv_1', status: 'canceled', total: 600 });
      return new Response(JSON.stringify({ message: 'no mock' }), { status: 400 });
    });
    process.env.FACTURAPI_USER_KEY = 'sk_user_platform';
    try {
      st = await call('PUT', '/invoicing', settings, tok);
      expect(st.body).toMatchObject({ available: true, connected: true, live: false });
      expect(calls.find((x) => x.path === '/organizations/org_1/legal')?.body).toMatchObject({ legal_name: 'DRA FACTURA', tax_system: '612', address: { zip: '28000' } });
      const cu = (await call('POST', '/customers', { name: 'Paciente Factura', phone: '5577003300', email: 'pf@correo.mx' }, tok)).body;
      const pay = (await call('POST', '/payments', { customerId: cu.id, amountCents: 60000, method: 'card' }, tok)).body;
      // Test invoice (no CSD yet), to the patient's RFC, saved for next time
      const fiscal = { rfc: 'PAFA800101AB1', legalName: 'PACIENTE FACTURA', taxSystem: '605', zip: '28010', use: 'D01' };
      const inv = await call('POST', `/payments/${pay.id}/invoice`, { customer: fiscal, save: true }, tok);
      expect(inv.status).toBe(201);
      expect(inv.body).toMatchObject({ uuid: 'AAAA-BBBB', series: 'F', folio: 7, totalCents: 60000, test: true });
      const sent = calls.find((x) => x.path === '/invoices')!;
      expect(sent.auth).toBe('Bearer sk_test_abc');
      expect(sent.body).toMatchObject({ payment_form: '04', use: 'D01', customer: { tax_id: 'PAFA800101AB1', email: 'pf@correo.mx' }, items: [{ product: { product_key: '85121500', price: 600, taxes: [{ type: 'IVA', factor: 'Exento' }] } }] });
      expect((await call('GET', `/customers/${cu.id}`, undefined, tok)).body.fiscal).toMatchObject({ rfc: 'PAFA800101AB1' });
      expect((await call('POST', `/payments/${pay.id}/invoice`, { customer: null }, tok)).body.error).toBe('already_invoiced');
      const listed = (await call('GET', `/payments?customerId=${cu.id}`, undefined, tok)).body;
      expect(listed[0].invoice).toMatchObject({ id: inv.body.id, folio: 7 });
      // PDF through the API
      const pdf = await app.request(`/api/invoices/${inv.body.id}/pdf`, { headers: { authorization: `Bearer ${tok}` } });
      expect(pdf.status).toBe(200);
      expect(await pdf.text()).toContain('%PDF');
      // CSD → live key from now on
      const fd = new FormData();
      fd.append('cer', new Blob(['cer']), 'a.cer');
      fd.append('key', new Blob(['key']), 'a.key');
      fd.append('password', 'secreto');
      const up = await app.request('/api/invoicing/certificate', { method: 'PUT', body: fd, headers: { authorization: `Bearer ${tok}` } });
      expect(((await up.json()) as { live: boolean }).live).toBe(true);
      // Cancel (motive 02) → payment can be invoiced again
      const can = await call('POST', `/invoices/${inv.body.id}/cancel`, { motive: '02' }, tok);
      expect(can.body.status).toBe('canceled');
      const again = await call('POST', `/payments/${pay.id}/invoice`, { customer: null }, tok);
      expect(again.status).toBe(201);
      expect(again.body.test).toBe(false);
      expect(calls.filter((x) => x.path === '/invoices').pop()).toMatchObject({ auth: 'Bearer sk_live_abc', body: { use: 'S01', customer: { tax_id: 'XAXX010101000', tax_system: '616' } } });
      // Keys never reach the browser
      expect(JSON.stringify((await call('GET', '/invoicing', undefined, tok)).body)).not.toContain('sk_');
    } finally {
      setFacturapiFetch(null);
      delete process.env.FACTURAPI_USER_KEY;
    }
  });

  it('point of sale: products, stock per location, counter sales, cash closing, cancel and invoice', async () => {
    const { setFacturapiFetch } = await import('../src/integrations/facturapi.js');
    const reg = (await call('POST', '/auth/register', { businessName: 'Barberia POS', businessType: 'barbershop', name: 'Dueño POS', email: 'pos@test.mx', password: 'password123' })).body;
    const tok = reg.token;
    // Not on the free plan
    await call('PUT', '/tenant/plan', { plan: 'free' }, tok);
    expect((await call('POST', '/products', { name: 'Pomada', priceCents: 25000 }, tok)).status).toBe(402);
    await call('PUT', '/tenant/plan', { plan: 'standard' }, tok);
    expect((await call('POST', '/products', { name: 'Mala', priceCents: 100, satKey: '123' }, tok)).status).toBe(422);
    const pomada = (await call('POST', '/products', { name: 'Pomada', category: 'Estilizado', priceCents: 25000, minStock: 2, initialStock: 3 }, tok)).body;
    expect(pomada).toMatchObject({ stock: 3, low: false, trackStock: true, iva: '16' });
    const med = (await call('POST', '/products', { name: 'Amoxicilina', priceCents: 12000, iva: '0', requiresPrescription: true, initialStock: 10, satKey: '51101500' }, tok)).body;
    const agua = (await call('POST', '/products', { name: 'Agua', priceCents: 2000, trackStock: false }, tok)).body;

    // Payments must add up; stock can't go below zero
    const items = [{ productId: pomada.id, qty: 2 }, { productId: agua.id, qty: 1 }, { name: 'Lavado sin cita', qty: 1, unitCents: 8000 }];
    expect((await call('POST', '/sales', { items, payments: [{ method: 'cash', amountCents: 100 }] }, tok)).body.error).toBe('payments_mismatch');
    expect((await call('POST', '/sales', { items: [{ productId: pomada.id, qty: 5 }], payments: [{ method: 'cash', amountCents: 125000 }] }, tok)).body.error).toBe('insufficient_stock');
    // 2×250 + 20 + 80 = 600, split cash/card, no customer
    const sale = await call('POST', '/sales', { items, payments: [{ method: 'cash', amountCents: 40000 }, { method: 'card', amountCents: 20000 }] }, tok);
    expect(sale.status).toBe(201);
    expect(sale.body).toMatchObject({ number: 1, totalCents: 60000, status: 'paid', customerId: null });
    expect(sale.body.payments.map((x: { method: string }) => x.method).sort()).toEqual(['card', 'cash']);
    let list = (await call('GET', '/products', undefined, tok)).body as { id: string; stock: number; low: boolean }[];
    expect(list.find((x) => x.id === pomada.id)).toMatchObject({ stock: 1, low: true });
    // The hidden counter customer doesn't show in the customer list
    expect((await call('GET', '/customers', undefined, tok)).body.items.some((x: { name: string }) => x.name === 'Venta de mostrador')).toBe(false);
    expect((await call('GET', '/customers?archived=1', undefined, tok)).body.items.some((x: { name: string }) => x.name === 'Venta de mostrador')).toBe(false);
    // Cash closing counts the sale
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
    const sum = (await call('GET', `/cash/summary?day=${day}`, undefined, tok)).body;
    expect(sum.byMethod.cash).toBe(40000);
    expect(sum.salesByKind.products).toBe(60000);
    // Receive and count stock; history keeps every move
    expect((await call('POST', `/products/${pomada.id}/stock`, { mode: 'in', qty: 5, note: 'Proveedor' }, tok)).body.qty).toBe(6);
    expect((await call('POST', `/products/${pomada.id}/stock`, { mode: 'set', qty: 4 }, tok)).body.qty).toBe(4);
    const moves = (await call('GET', `/products/${pomada.id}/moves`, undefined, tok)).body as { reason: string; qtyChange: number; saleNumber: number | null }[];
    expect(moves.map((m) => [m.reason, m.qtyChange])).toEqual([['adjust', -2], ['in', 5], ['sale', -2], ['in', 3]]);
    expect(moves[2]!.saleNumber).toBe(1);

    // Invoice the whole sale from one of its payments (mocked Facturapi)
    process.env.FACTURAPI_USER_KEY = 'sk_user_platform';
    const sent: { path: string; body: any }[] = [];
    setFacturapiFetch(async (url, init) => {
      const path = url.replace('https://www.facturapi.io/v2', '');
      if (typeof init.body === 'string') sent.push({ path, body: JSON.parse(init.body) });
      const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
      if (path === '/organizations') return json({ id: 'org_p' });
      if (path.endsWith('/apikeys/test')) return json('sk_test_p');
      if (path.endsWith('/legal')) return json({ ok: true });
      if (path === '/invoices') return json({ id: 'inv_p', uuid: 'U-P', series: 'F', folio_number: 1, total: 600, status: 'valid' });
      return new Response('{}', { status: 400 });
    });
    try {
      await call('PUT', '/invoicing', { rfc: 'XEXX010101000', legalName: 'BARBERIA', taxSystem: '626', zip: '28000', series: 'F', productKey: '85121500', description: 'Servicio', iva: '16', autoEmail: false }, tok);
      const inv = await call('POST', `/payments/${sale.body.payments[1].id}/invoice`, { customer: null }, tok);
      expect(inv.status).toBe(201);
      const body = sent.find((x) => x.path === '/invoices')!.body;
      expect(body.payment_form).toBe('01'); // largest payment was cash
      expect(body.items.map((i: any) => [i.quantity, i.product.description, i.product.product_key, i.product.price])).toEqual([
        [2, 'Pomada', '01010101', 250],
        [1, 'Agua', '01010101', 20],
        [1, 'Lavado sin cita', '85121500', 80],
      ]);
      expect((await call('POST', `/payments/${sale.body.payments[0].id}/invoice`, { customer: null }, tok)).body.error).toBe('already_invoiced');
      // Invoiced sales are canceled only after canceling the invoice
      expect((await call('POST', `/sales/${sale.body.id}/cancel`, {}, tok)).body.error).toBe('cancel_invoice_first');
    } finally {
      setFacturapiFetch(null);
      delete process.env.FACTURAPI_USER_KEY;
    }

    // A second sale with a customer and a prescription product, then canceled: stock and money go back
    const cu = (await call('POST', '/customers', { name: 'Cliente POS', phone: '5577001122' }, tok)).body;
    const s2 = (await call('POST', '/sales', { customerId: cu.id, items: [{ productId: med.id, qty: 2, unitCents: 11000 }], payments: [{ method: 'transfer', amountCents: 22000 }] }, tok)).body;
    expect(s2).toMatchObject({ number: 2, customerName: 'Cliente POS', totalCents: 22000 });
    expect(s2.items[0]).toMatchObject({ iva: '0', satKey: '51101500', unitCents: 11000 });
    const ticket = (await call('GET', `/sales/${s2.id}/ticket`, undefined, tok)).body;
    expect(ticket).toMatchObject({ business: { name: 'Barberia POS', rfc: 'XEXX010101000', legalName: 'BARBERIA' }, multiLocation: false, invoicing: true, sale: { number: 2, customerName: 'Cliente POS' } });
    expect((await call('POST', `/sales/${s2.id}/cancel`, {}, tok)).status).toBe(200);
    expect((await call('POST', `/sales/${s2.id}/cancel`, {}, tok)).body.error).toBe('already_canceled');
    list = (await call('GET', '/products', undefined, tok)).body;
    expect(list.find((x) => x.id === med.id)!.stock).toBe(10);
    const pays = (await call('GET', `/payments?customerId=${cu.id}`, undefined, tok)).body;
    expect(pays[0]).toMatchObject({ status: 'refunded', saleId: s2.id });
    const sales = (await call('GET', '/sales', undefined, tok)).body as { number: number; status: string }[];
    expect(sales.map((x) => [x.number, x.status])).toEqual([[2, 'canceled'], [1, 'paid']]);
    // Sold products are only hidden
    expect((await call('DELETE', `/products/${pomada.id}`, undefined, tok)).body).toEqual({ deactivated: true });
    expect((await call('GET', '/products', undefined, tok)).body.some((x: { id: string }) => x.id === pomada.id)).toBe(false);
    // Another business can't see them
    const other = (await call('POST', '/auth/register', { businessName: 'Otra POS', businessType: 'barbershop', name: 'Otro', email: 'pos2@test.mx', password: 'password123' })).body.token;
    expect((await call('GET', '/products', undefined, other)).body).toEqual([]);
    expect((await call('POST', `/sales/${s2.id}/cancel`, {}, other)).status).toBe(404);
    expect((await call('GET', `/sales/${s2.id}/ticket`, undefined, other)).status).toBe(404);
    expect((await call('POST', '/sales', { items: [{ productId: med.id, qty: 1 }], payments: [{ method: 'cash', amountCents: 12000 }] }, other)).status).toBe(404);
  });

  it('clinical record (NOM-004): signed notes never change, addendum, bitácora, 5-year retention', async () => {
    const reg = (await call('POST', '/auth/register', {
      businessName: 'Consultorio Prueba', businessType: 'medical', name: 'Dra. Ana Ruiz', email: 'nom004@test.mx', password: 'password123',
    })).body;
    const tok = reg.token;
    // Cédula and specialty on the profile
    const meU = await call('PATCH', '/auth/me', { professional: { license: '1234567', institution: 'UNAM', specialty: 'Medicina familiar' } }, tok);
    expect(meU.body.professional).toMatchObject({ license: '1234567', specialty: 'Medicina familiar' });
    const pat = (await call('POST', '/customers', { name: 'Paciente Nom', phone: '5577001100', birthday: '1990-05-04', sex: 'F', address: 'Calle 1, Colima', curp: 'rual900504mclzzn09' }, tok)).body;
    expect(pat).toMatchObject({ sex: 'F', curp: 'RUAL900504MCLZZN09' });
    expect((await call('POST', '/customers', { name: 'Mala Curp', phone: '5577001101', curp: 'XX' }, tok)).status).toBe(422);
    // Editing without the patient fields keeps them
    const kept = (await call('PUT', `/customers/${pat.id}`, { name: 'Paciente Nom', phone: '5577001100' }, tok)).body;
    expect(kept.address).toBe('Calle 1, Colima');

    // Not for non-health giros
    const barber = (await call('POST', '/customers', { name: 'Cliente Barba', phone: '5577001102' }, a.token)).body;
    expect((await call('GET', `/customers/${barber.id}/clinical`, undefined, a.token)).status).toBe(422);

    // Draft → incomplete sign refused → complete → signed with the password
    const draft = await call('POST', `/customers/${pat.id}/clinical-notes`, { template: 'medical_evolution', content: { evolucion: 'Tos de 3 días' } }, tok);
    expect(draft.status).toBe(201);
    expect(draft.body.status).toBe('draft');
    expect((await call('POST', `/clinical-notes/${draft.body.id}/sign`, { password: 'password123' }, tok)).body.error).toBe('clinical_incomplete');
    const content = {
      evolucion: 'Tos de 3 días sin fiebre', signos: { ta: '120/80', fc: 78, temp: 36.6 }, diagnosticos: [{ code: 'J00', text: 'Rinofaringitis aguda' }],
      pronostico: 'Bueno', medicamentos: [{ name: 'Paracetamol 500 mg', dose: '1 tableta', route: 'Oral', frequency: 'Cada 8 h', duration: '3 días' }], indicaciones: 'Líquidos abundantes',
    };
    expect((await call('PUT', `/clinical-notes/${draft.body.id}`, { content }, tok)).status).toBe(200);
    expect((await call('POST', `/clinical-notes/${draft.body.id}/sign`, { password: 'mala' }, tok)).body.error).toBe('wrong_password');
    const signed = await call('POST', `/clinical-notes/${draft.body.id}/sign`, { password: 'password123' }, tok);
    expect(signed.body).toMatchObject({ status: 'signed', author: { name: 'Dra. Ana Ruiz', license: '1234567' } });
    expect(signed.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // Signed: can't change or delete
    expect((await call('PUT', `/clinical-notes/${draft.body.id}`, { content: { evolucion: 'otra' } }, tok)).body.error).toBe('clinical_signed');
    expect((await call('DELETE', `/clinical-notes/${draft.body.id}`, undefined, tok)).status).toBe(409);
    // Correction = signed nota aclaratoria
    const add = await call('POST', `/clinical-notes/${draft.body.id}/addendum`, { text: 'La temperatura fue 37.1', password: 'password123' }, tok);
    expect(add.body).toMatchObject({ kind: 'addendum', status: 'signed', amendsId: draft.body.id });
    // Signed right away (history) and a template from another giro refused
    expect((await call('POST', `/customers/${pat.id}/clinical-notes`, { template: 'dental_history', content: {} }, tok)).body.error).toBe('clinical_template');

    const rec = (await call('GET', `/customers/${pat.id}/clinical`, undefined, tok)).body;
    expect(rec.norm).toBe('NOM-004-SSA3-2012');
    expect(rec.patient).toMatchObject({ birthday: '1990-05-04', sex: 'F' });
    expect(rec.notes.map((n: { kind: string }) => n.kind)).toEqual(['addendum', 'evolution']);
    expect(rec.notes[1].content.diagnosticos[0].code).toBe('J00');
    // Encrypted at rest
    const { getDb } = await import('../src/db/client.js');
    const { sql } = await import('drizzle-orm');
    const raw = (await getDb().execute(sql`select content_enc from clinical_notes where customer_id = ${pat.id} limit 1`)).rows[0] as { content_enc: string };
    expect(raw.content_enc).not.toContain('Paracetamol');
    // Bitácora (owner) and prints
    await call('POST', `/customers/${pat.id}/clinical-log`, { action: 'print', detail: 'Receta' }, tok);
    const log = (await call('GET', `/customers/${pat.id}/clinical-log`, undefined, tok)).body;
    expect(log.map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining(['view', 'sign', 'addendum', 'print']));
    // Drafts of someone else are not shown; team members who didn't attend can't open it
    const rx = (await call('POST', '/resources', { name: 'Dr. Otro' }, tok)).body;
    await call('POST', '/users', { name: 'Dr. Otro', email: 'nom004-otro@test.mx', password: 'password123', role: 'staff', resourceId: rx.id }, tok);
    const otro = (await call('POST', '/auth/login', { email: 'nom004-otro@test.mx', password: 'password123' })).body.token;
    expect((await call('GET', `/customers/${pat.id}/clinical`, undefined, otro)).status).toBe(403);
    // 5 years: delete refused, archive instead
    const del = await call('DELETE', `/customers/${pat.id}`, undefined, tok);
    expect(del.body.error).toBe('record_retention');
    expect((await call('PUT', `/customers/${pat.id}`, { name: 'Paciente Nom', phone: '5577001100', archived: true }, tok)).body.archived).toBe(true);
    const listed = (await call('GET', '/customers?q=Paciente%20Nom', undefined, tok)).body.items;
    expect(listed).toHaveLength(0);
    expect((await call('GET', '/customers?archived=1&q=Paciente%20Nom', undefined, tok)).body.items).toHaveLength(1);
  });

  it('link preview for a business page', async () => {
    const res = await app.request('/api/page/b/negocio-a');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('og:title" content="Negocio a');
    expect(html).toContain('og:image" content="');
    expect(html).toContain('<div id="root">');
    const none = await (await app.request('/api/page/b/no-existe')).text();
    expect(none).not.toContain('og:url');
  });

  it('plans: Individual is one agenda; Premium includes two locations', async () => {
    const reg = (await call('POST', '/auth/register', {
      businessName: 'Plan Individual', businessType: 'psychology', name: 'Psic Uno', email: 'individual@test.mx', password: 'password123', plan: 'individual',
    })).body;
    const tok = reg.token;
    expect(reg.tenant.plan).toBe('individual');
    expect((await call('POST', '/resources', { name: 'Yo' }, tok)).status).toBe(201);
    const second = await call('POST', '/resources', { name: 'Otra' }, tok);
    expect(second.status).toBe(402);
    expect(second.body.error).toBe('plan_limit_resources');
    // Inactive ones don't count; reactivating does
    const off = (await call('POST', '/resources', { name: 'Archivo', active: false }, tok));
    expect(off.status).toBe(201);
    expect((await call('PUT', `/resources/${off.body.id}`, { name: 'Archivo', active: true }, tok)).status).toBe(402);
    expect((await call('POST', '/locations', { name: 'Segunda' }, tok)).status).toBe(402);
    const info = (await call('GET', '/tenant/plan', undefined, tok)).body;
    expect(info).toMatchObject({ plan: 'individual', monthlyTotalCents: 24900, usage: { activeResources: 1 } });
    // Premium: second location included, third is an extra
    expect((await call('PUT', '/tenant/plan', { plan: 'premium' }, tok)).status).toBe(200);
    expect((await call('POST', '/resources', { name: 'Otra' }, tok)).status).toBe(201);
    expect((await call('POST', '/locations', { name: 'Segunda' }, tok)).body.plan).toMatchObject({ includedLocations: 2, extraLocations: 0 });
    expect((await call('GET', '/tenant/plan', undefined, tok)).body.monthlyTotalCents).toBe(79900);
    expect((await call('POST', '/locations', { name: 'Tercera' }, tok)).body.plan.extraLocations).toBe(1);
    // Back to Individual is refused while it has more than one agenda/location
    expect((await call('PUT', '/tenant/plan', { plan: 'individual' }, tok)).status).toBe(402);
  });

  it('verified reviews and calendar links', async () => {
    const reg = (await call('POST', '/auth/register', {
      businessName: 'Reseñas Prueba', businessType: 'barbershop', name: 'Dueño Reseñas', email: 'resenas@test.mx', password: 'password123',
    })).body;
    const tok = reg.token;
    const svc = (await call('POST', '/services', { name: 'Corte', durationMin: 30, priceCents: 20000 }, tok)).body;
    const res = (await call('POST', '/resources', { name: 'Toño' }, tok)).body;
    const cust = (await call('POST', '/customers', { name: 'María González Pérez', phone: '5588880041' }, tok)).body;
    const appt = (await call('POST', '/appointments', { customerId: cust.id, serviceId: svc.id, resourceId: res.id, startsAt: DateTime.now().plus({ days: 1 }).toISO(), allowOverlap: true }, tok)).body;
    const token = appt.managePath.split('/c/')[1];
    expect((await call('GET', `/public/reviews/${token}`)).body.notYet).toBe(true);
    expect((await call('POST', `/public/reviews/${token}`, { rating: 5 })).status).toBe(422);
    await call('PATCH', `/appointments/${appt.id}`, { status: 'completed' }, tok);
    expect((await call('GET', `/public/manage/${token}`)).body.reviewPath).toBe(`/r/${token}`);
    expect((await call('POST', `/public/reviews/${token}`, { rating: 5, comment: 'Excelente' })).status).toBe(201);
    expect((await call('POST', `/public/reviews/${token}`, { rating: 1, comment: 'Otra' })).status).toBe(409);
    expect((await call('POST', '/public/reviews/x.y', { rating: 5 })).status).toBe(404);
    const slug = reg.tenant.slug;
    // One review isn't published yet: from 3 on
    let pub = (await call('GET', `/public/${slug}`)).body.reviews;
    expect(pub).toMatchObject({ average: null, count: 0 });
    for (const [i, rating] of [4, 3].entries()) {
      const cu = (await call('POST', '/customers', { name: `Cliente Reseña ${i}`, phone: `558888005${i}` }, tok)).body;
      const ap = (await call('POST', '/appointments', { customerId: cu.id, serviceId: svc.id, resourceId: res.id, startsAt: DateTime.now().plus({ days: 2 + i }).toISO(), allowOverlap: true }, tok)).body;
      await call('PATCH', `/appointments/${ap.id}`, { status: 'completed' }, tok);
      expect((await call('POST', `/public/reviews/${ap.managePath.split('/c/')[1]}`, { rating })).status).toBe(201);
    }
    pub = (await call('GET', `/public/${slug}`)).body.reviews;
    expect(pub).toMatchObject({ average: 4, count: 3 });
    const list = (await call('GET', '/reviews', undefined, tok)).body;
    const maria = list.items.find((r: { comment: string | null }) => r.comment === 'Excelente');
    expect(pub.recent.find((r: { comment: string | null }) => r.comment === 'Excelente')).toMatchObject({ authorName: 'María G.' });
    await call('PATCH', `/reviews/${maria.id}`, { reply: '¡Gracias, María!' }, tok);
    expect((await call('GET', `/public/${slug}`)).body.reviews.recent.find((r: { comment: string | null }) => r.comment === 'Excelente').reply).toBe('¡Gracias, María!');
    // The business can keep reviews private: page and directory show none
    const me = (await call('GET', '/auth/me', undefined, tok)).body;
    await call('PATCH', '/tenant', { settings: { ...me.tenant.settings, reviews: { public: false } } }, tok);
    expect((await call('GET', `/public/${slug}`)).body.reviews.count).toBe(0);
    expect((await call('GET', '/reviews', undefined, tok)).body.count).toBe(3);
    await call('PATCH', '/tenant', { settings: { ...me.tenant.settings, reviews: { public: true } } }, tok);
    await call('PATCH', `/reviews/${maria.id}`, { hidden: true }, tok);
    pub = (await call('GET', `/public/${slug}`)).body.reviews;
    expect(pub.count).toBe(0);

    // Calendar: business link and per team member, no phone numbers; regenerate kills the old one
    const feeds = (await call('GET', '/calendar-feeds', undefined, tok)).body as { scope: string; url: string; resourceId: string | null }[];
    const biz = feeds.find((f) => f.scope === 'business')!;
    expect(feeds.some((f) => f.resourceId === res.id)).toBe(true);
    const path = new URL(biz.url).pathname;
    const ics = await app.request(path);
    const text = await ics.text();
    expect(ics.headers.get('content-type')).toContain('text/calendar');
    expect(text).toContain('SUMMARY:Corte · María');
    expect(text).not.toContain('5588880041');
    expect(text).not.toContain('González');
    const again = (await call('POST', '/calendar-feeds/regenerate', { scope: 'business' }, tok)).body;
    expect(again.url).not.toBe(biz.url);
    expect((await app.request(path)).status).toBe(404);
    expect((await app.request(new URL(again.url).pathname)).status).toBe(200);
  });
});
