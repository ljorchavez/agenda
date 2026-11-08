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
    let day = DateTime.now().setZone('America/Mexico_City').plus({ days: 5 });
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
    const tables = await call('GET', '/tables', undefined, tok);
    expect(tables.body.map((t: { seats: number }) => t.seats)).toEqual([2, 2, 4, 4, 6]);
    // B can't see A's tables
    expect((await call('GET', '/tables', undefined, b.token)).body).toHaveLength(0);
    expect((await call('PUT', `/tables/${tables.body[0].id}`, { name: 'x', seats: 2 }, b.token)).status).toBe(404);

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
    const names = list.body.map((a: { tableName: string }) => a.tableName).sort();
    expect(names).toEqual(['Mesa 1', 'Mesa 2', 'Mesa 3', 'Mesa 4', 'Mesa 5']);
    expect(new Set(list.body.map((a: { tableId: string }) => a.tableId)).size).toBe(5);

    // Staff reservation at the same time has no table left -> 409; with allowOverlap it's saved without a table
    const cust = await call('POST', '/customers', { name: 'Walk In', phone: '5512345000' }, tok);
    const svc = (await call('GET', '/services', undefined, tok)).body[0];
    const noRoom = await call('POST', '/appointments', { customerId: cust.body.id, serviceId: svc.id, startsAt: slot, partySize: 2 }, tok);
    expect(noRoom.status).toBe(409);
    expect(noRoom.body.error).toBe('no_table_available');
    const walkIn = await call('POST', '/appointments', { customerId: cust.body.id, serviceId: svc.id, startsAt: slot, partySize: 2, allowOverlap: true }, tok);
    expect(walkIn.status).toBe(201);
    expect(walkIn.body.tableId).toBeNull();

    // Cancelling frees the table for the next booking
    await call('PATCH', `/appointments/${seated[0]}`, { status: 'cancelled' }, tok);
    expect((await call('POST', '/public/restaurante-prueba/bookings', { partySize: 2, startsAt: slot, name: 'Grupo 7', phone: '5500001197' })).status).toBe(201);

    // Customer reschedule keeps a table
    const one = (await call('GET', `/appointments?from=${day.startOf('day').toISO()}&to=${day.endOf('day').toISO()}`, undefined, tok)).body.find((a: { tableId: string | null; status: string }) => a.tableId && a.status === 'scheduled');
    const later = av.body.slots[av.body.slots.length - 1];
    const moved = await call('POST', `/public/manage/${one.managePath.slice(3)}/reschedule`, { startsAt: later });
    expect(moved.status).toBe(200);
    expect(moved.body.appointment.partySize).toBe(2);
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
});
