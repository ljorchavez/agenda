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
    const p1 = await call('POST', '/professionals', { name: 'Toño', color: '#2563eb' }, tok);
    expect(p1.status).toBe(201);
    // ...goes to the first professional
    expect((await call('GET', `/appointments/${pre.id}`, undefined, tok)).body.professionalName).toBe('Toño');
    const p2 = (await call('POST', '/professionals', { name: 'Memo', serviceIds: [corte.id] }, tok)).body;
    expect(p2.serviceIds).toEqual([corte.id]);
    expect((await call('GET', '/professionals', undefined, b.token)).body).toHaveLength(0);
    expect((await call('PUT', `/professionals/${p2.id}`, { name: 'x' }, b.token)).status).toBe(404);
    expect((await call('POST', '/professionals', { name: 'Raro', serviceIds: [corte.id] }, b.token)).status).toBe(404);

    const pub = await call('GET', '/public/barberia-equipo');
    expect(pub.body.professionals.map((p: { name: string }) => p.name)).toEqual(['Memo', 'Toño']);
    expect(JSON.stringify(pub.body.professionals)).not.toContain('userId');
    const avail = async (svc: string, pro?: string) =>
      (await call('GET', `/public/barberia-equipo/availability?serviceId=${svc}&date=${day.toISODate()}${pro ? `&professionalId=${pro}` : ''}`)).body.slots as string[];
    expect(await avail(corte.id)).toContain(at(10)); // Memo is free
    expect(await avail(corte.id, p1.body.id)).not.toContain(at(10));
    expect(await avail(barba.id)).not.toContain(at(10)); // only Toño does beards
    expect(await avail(barba.id)).toContain(at(11));

    const any = await call('POST', '/public/barberia-equipo/bookings', { serviceId: corte.id, startsAt: at(10), name: 'Ana', phone: '5533330001' });
    expect(any.status).toBe(201);
    expect(any.body.resourceName).toBe('Memo');
    expect((await call('POST', '/public/barberia-equipo/bookings', { serviceId: corte.id, startsAt: at(10), name: 'Beto', phone: '5533330002' })).status).toBe(409);
    const specific = await call('POST', '/public/barberia-equipo/bookings', { serviceId: corte.id, professionalId: p2.id, startsAt: at(10, 30), name: 'Caro', phone: '5533330003' });
    expect(specific.body.resourceName).toBe('Memo');

    // Staff: busy professional -> 409; allowOverlap -> saved; wrong service -> 422
    const busy = await call('POST', '/appointments', { customerId: cust.id, serviceId: corte.id, professionalId: p1.body.id, startsAt: at(10) }, tok);
    expect(busy.status).toBe(409);
    expect(busy.body.error).toBe('professional_busy');
    expect((await call('POST', '/appointments', { customerId: cust.id, serviceId: corte.id, professionalId: p1.body.id, startsAt: at(10), allowOverlap: true }, tok)).status).toBe(201);
    const wrong = await call('POST', '/appointments', { customerId: cust.id, serviceId: barba.id, professionalId: p2.id, startsAt: at(12) }, tok);
    expect(wrong.status).toBe(422);
    expect(wrong.body.error).toBe('professional_service');
    const auto = await call('POST', '/appointments', { customerId: cust.id, serviceId: barba.id, startsAt: at(12) }, tok);
    expect(auto.body.professionalName).toBe('Toño');
    // Moving Toño's beard to a time Toño is busy fails; moving it to a free time works
    expect((await call('PATCH', `/appointments/${auto.body.id}`, { startsAt: at(10) }, tok)).status).toBe(409);
    expect((await call('PATCH', `/appointments/${auto.body.id}`, { startsAt: at(13) }, tok)).status).toBe(200);

    // Customer reschedule keeps their professional
    const moved = await call('POST', `/public/manage/${any.body.managePath.slice(3)}/reschedule`, { startsAt: at(11) });
    expect(moved.status).toBe(200);
    expect(moved.body.appointment.resourceName).toBe('Memo');

    const rep = await call('GET', `/reports?from=${day.minus({ days: 30 }).toISODate()}&to=${day.toISODate()}&professionalId=${p2.id}`, undefined, tok);
    expect(rep.status).toBe(200);
    expect(Array.isArray(rep.body.byProfessional)).toBe(true);
    // Professionals with history are deactivated, not deleted
    expect((await call('DELETE', `/professionals/${p2.id}`, undefined, tok)).body.deactivated).toBe(true);
  });

  it('classes: sessions with capacity, public signup, move and cancel', async () => {
    const reg = await call('POST', '/auth/register', {
      businessName: 'Estudio Prueba', businessType: 'yoga', name: 'Lau', email: 'yoga@test.mx', password: 'password123',
    });
    const tok = reg.body.token;
    expect(reg.body.tenant.kind).toBe('classes');
    expect((await call('GET', '/services', undefined, tok)).body.map((s: { name: string }) => s.name)).toContain('Clase grupal');
    const svc = (await call('POST', '/services', { name: 'Vinyasa', durationMin: 60, priceCents: 15000 }, tok)).body;
    const inst = (await call('POST', '/professionals', { name: 'Lau' }, tok)).body;
    const day = DateTime.now().setZone('America/Mexico_City').plus({ days: 3 }).set({ hour: 8, minute: 0, second: 0, millisecond: 0 });

    const s1 = await call('POST', '/class-sessions', { serviceId: svc.id, professionalId: inst.id, startsAt: day.toISO(), capacity: 2 }, tok);
    expect(s1.status).toBe(201);
    expect(s1.body.booked).toBe(0);
    expect(new Date(s1.body.endsAt).getTime() - new Date(s1.body.startsAt).getTime()).toBe(3600e3);
    const clash = await call('POST', '/class-sessions', { serviceId: svc.id, professionalId: inst.id, startsAt: day.plus({ minutes: 30 }).toISO(), capacity: 5 }, tok);
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('instructor_busy');
    const copy = await call('POST', `/class-sessions/${s1.body.id}/copy`, { days: 1 }, tok);
    expect(copy.status).toBe(201);
    expect(new Date(copy.body.startsAt).getTime() - new Date(s1.body.startsAt).getTime()).toBe(86400e3);
    expect((await call('GET', `/class-sessions/${s1.body.id}`, undefined, b.token)).status).toBe(404);

    const list = (await call('GET', '/public/estudio-prueba/classes')).body;
    const pubS1 = list.find((x: { id: string }) => x.id === s1.body.id);
    expect(pubS1).toMatchObject({ spotsLeft: 2, priceCents: 15000, professionalName: 'Lau', serviceName: 'Vinyasa' });
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
    const list = (await call('GET', '/spaces', undefined, tok)).body;
    expect(list.map((x: { name: string }) => x.name)).toEqual(['Cancha 1', 'Cancha 2']);
    const [c1, c2] = list;
    await call('PUT', `/spaces/${c1.id}`, { name: 'Cancha 1', pricePerHourCents: 40000 }, tok);
    await call('PUT', `/spaces/${c2.id}`, { name: 'Cancha 2', pricePerHourCents: 50000 }, tok);
    expect((await call('GET', '/spaces', undefined, b.token)).body).toHaveLength(0);
    expect((await call('PUT', `/spaces/${c1.id}`, { name: 'x', pricePerHourCents: 1 }, b.token)).status).toBe(404);

    const pub = (await call('GET', '/public/padel-prueba')).body;
    expect(pub).toMatchObject({ kind: 'rentals', rentalDurations: [60, 90, 120], services: [] });
    expect(pub.spaces.map((x: { pricePerHourCents: number }) => x.pricePerHourCents)).toEqual([40000, 50000]);

    let day = DateTime.now().setZone('America/Mexico_City').plus({ days: 2 });
    while (day.weekday === 7) day = day.plus({ days: 1 });
    const at = (h: number, m = 0) => day.set({ hour: h, minute: m, second: 0, millisecond: 0 }).toISO()!;
    const avail = async (dur: number, space?: string) =>
      (await call('GET', `/public/padel-prueba/availability?durationMin=${dur}&date=${day.toISODate()}${space ? `&spaceId=${space}` : ''}`)).body.slots as string[];
    expect(await avail(90)).toContain(at(10));
    expect((await call('GET', `/public/padel-prueba/availability?durationMin=45&date=${day.toISODate()}`)).status).toBe(400);

    const r1 = await call('POST', '/public/padel-prueba/bookings', { spaceId: c1.id, durationMin: 90, startsAt: at(10), name: 'Jugador Uno', phone: '5566660001' });
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
    const taken = await call('POST', '/appointments', { customerId: cust.id, spaceId: c1.id, startsAt: at(10, 30), durationMin: 60 }, tok);
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe('space_taken');
    const staff = await call('POST', '/appointments', { customerId: cust.id, startsAt: at(12), durationMin: 120 }, tok);
    expect(staff.status).toBe(201);
    expect(staff.body).toMatchObject({ spaceName: 'Cancha 1', priceCents: 80000 });

    const mv = await call('POST', `/public/manage/${r1.body.managePath.slice(3)}/reschedule`, { startsAt: at(15) });
    expect(mv.status).toBe(200);
    expect(mv.body.appointment.resourceName).toBe('Cancha 1');

    const settings = { ...reg.body.tenant.settings, rentals: { durations: [60] } };
    expect((await call('PATCH', '/tenant', { settings }, tok)).body.settings.rentals.durations).toEqual([60]);
    const rep = await call('GET', `/reports?from=${day.minus({ days: 1 }).toISODate()}&to=${day.toISODate()}`, undefined, tok);
    expect(Array.isArray(rep.body.bySpace)).toBe(true);
  });

  it('roles: owner, admin and team members only see their own bookings', async () => {
    const owner = (await call('POST', '/auth/register', {
      businessName: 'Barberia Roles', businessType: 'barbershop', name: 'Dueña', email: 'roles-owner@test.mx', password: 'password123',
    })).body as AuthResponse;
    const tok = owner.token;
    expect(owner.user).toMatchObject({ role: 'owner', professionalId: null });
    const svc = (await call('POST', '/services', { name: 'Corte', durationMin: 30, priceCents: 20000 }, tok)).body;
    const pA = (await call('POST', '/professionals', { name: 'Ana' }, tok)).body;
    const pB = (await call('POST', '/professionals', { name: 'Beto' }, tok)).body;

    // Owner creates an admin and a team member linked to Ana
    const admin = await call('POST', '/users', { name: 'Recepción', email: 'roles-admin@test.mx', password: 'password123', role: 'admin' }, tok);
    expect(admin.status).toBe(201);
    const staff = await call('POST', '/users', { name: 'Ana', email: 'roles-ana@test.mx', password: 'password123', role: 'staff', professionalId: pA.id }, tok);
    expect(staff.body).toMatchObject({ role: 'staff', professionalId: pA.id, professionalName: 'Ana' });
    const adminTok = (await call('POST', '/auth/login', { email: 'roles-admin@test.mx', password: 'password123' })).body.token;
    const anaLogin = (await call('POST', '/auth/login', { email: 'roles-ana@test.mx', password: 'password123' })).body;
    expect(anaLogin.user).toMatchObject({ role: 'staff', professionalId: pA.id });
    const anaTok = anaLogin.token;

    // Admin can only create team members, not other admins/owners
    expect((await call('POST', '/users', { name: 'Equis', email: 'roles-x@test.mx', password: 'password123', role: 'admin' }, adminTok)).status).toBe(403);
    expect((await call('POST', '/users', { name: 'Beto', email: 'roles-beto@test.mx', password: 'password123', role: 'staff', professionalId: pB.id }, adminTok)).status).toBe(201);
    // Team members can't see or manage logins, catalog or team
    expect((await call('GET', '/users', undefined, anaTok)).status).toBe(403);
    expect((await call('POST', '/services', { name: 'Tinte', durationMin: 60, priceCents: 1 }, anaTok)).status).toBe(403);
    expect((await call('POST', '/professionals', { name: 'Nadie' }, anaTok)).status).toBe(403);
    expect((await call('PATCH', '/tenant', { name: 'Hackeado' }, anaTok)).status).toBe(403);
    // Admin runs the business but can't touch payment settings or Mercado Pago
    expect((await call('POST', '/services', { name: 'Tinte', durationMin: 60, priceCents: 50000 }, adminTok)).status).toBe(201);
    expect((await call('PUT', '/tenant/mercadopago', { accessToken: 'APP_USR-12345678901234567890' }, adminTok)).status).toBe(403);

    // Bookings for both barbers
    const cust1 = (await call('POST', '/customers', { name: 'Cliente Ana', phone: '5560000001' }, tok)).body;
    const cust2 = (await call('POST', '/customers', { name: 'Cliente Beto', phone: '5560000002' }, tok)).body;
    const at = DateTime.now().plus({ days: 3 }).set({ hour: 11, minute: 0, second: 0, millisecond: 0 });
    const apA = (await call('POST', '/appointments', { customerId: cust1.id, serviceId: svc.id, professionalId: pA.id, startsAt: at.toISO() }, tok)).body;
    const apB = (await call('POST', '/appointments', { customerId: cust2.id, serviceId: svc.id, professionalId: pB.id, startsAt: at.toISO() }, tok)).body;
    expect(apA.professionalId).toBe(pA.id);
    expect(apB.professionalId).toBe(pB.id);
    const range = `from=${encodeURIComponent(at.minus({ days: 1 }).toISO()!)}&to=${encodeURIComponent(at.plus({ days: 1 }).toISO()!)}`;

    expect((await call('GET', `/appointments?${range}`, undefined, tok)).body).toHaveLength(2);
    expect((await call('GET', `/appointments?${range}`, undefined, adminTok)).body).toHaveLength(2);
    const mine = (await call('GET', `/appointments?${range}`, undefined, anaTok)).body;
    expect(mine.map((x: { id: string }) => x.id)).toEqual([apA.id]);
    expect((await call('GET', `/appointments/${apB.id}`, undefined, anaTok)).status).toBe(404);
    expect((await call('PATCH', `/appointments/${apB.id}`, { status: 'cancelled' }, anaTok)).status).toBe(404);
    expect((await call('PATCH', `/appointments/${apA.id}`, { professionalId: pB.id }, anaTok)).status).toBe(403);
    expect((await call('DELETE', `/appointments/${apA.id}`, undefined, anaTok)).status).toBe(403);
    // Ana books into her own agenda only
    expect((await call('POST', '/appointments', { customerId: cust2.id, serviceId: svc.id, professionalId: pB.id, startsAt: at.plus({ hours: 2 }).toISO() }, anaTok)).status).toBe(403);
    const own = await call('POST', '/appointments', { customerId: cust2.id, serviceId: svc.id, startsAt: at.plus({ hours: 2 }).toISO() }, anaTok);
    expect(own.status).toBe(201);
    expect(own.body.professionalId).toBe(pA.id);
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
    const rep = (await call('GET', `/reports?from=${today}&to=${day}&professionalId=${pB.id}`, undefined, anaTok)).body;
    expect(rep.kpis.completed).toBe(1);
    expect(rep.byProfessional.map((x: { name: string }) => x.name)).toEqual(['Ana']);
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
    // Unlinked team member sees nothing in a team business
    await call('PATCH', `/users/${anaId}`, { professionalId: null }, tok);
    expect((await call('GET', `/appointments?${range}`, undefined, anaTok)).body).toHaveLength(0);
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
});
