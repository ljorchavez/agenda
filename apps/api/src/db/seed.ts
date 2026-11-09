/**
 * Demo data: `pnpm db:seed`
 * Creates a nutrition clinic with services, customers and ~14 months of appointments/payments and two team members.
 * Also a restaurant (restaurante@agenda.mx / demo1234) and a set of clearly-labelled demo
 * businesses (slug `demo-*`) so the public directory map has content.
 * Also a barbershop with 3 barbers (barberia@agenda.mx), a yoga studio with classes (clases@agenda.mx)
 * and a padel club renting courts (padel@agenda.mx). Same password.
 * Login: demo@agenda.mx / demo1234
 */
import { eq, like } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DEFAULT_PAYMENT_SETTINGS, DEFAULT_TENANT_SETTINGS } from '@agenda/shared';
import { hashPassword } from '../lib/auth.js';
import { closeDb, getDb } from './client.js';
import { appointments, classSessions, customers, diningTables, payments, professionals, services, spaces, tenants, users } from './schema.js';

const TZ = 'America/Mexico_City';

// Deterministic pseudo-random so the demo looks the same every time.
let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

async function main() {
  const db = getDb();
  const existing = await db.query.tenants.findFirst({ where: eq(tenants.slug, 'nutricion-demo') });
  if (existing) {
    await db.delete(tenants).where(eq(tenants.id, existing.id));
    console.log('Removed previous demo tenant');
  }

  const [tenant] = await db
    .insert(tenants)
    .values({
      name: 'Nutrición Demo',
      slug: 'nutricion-demo',
      businessType: 'nutrition',
      phone: '+525512345678',
      timezone: TZ,
      description: 'Consulta de nutrición, planes alimenticios y bioimpedancia. Cuenta de demostración.',
      address: 'Av. Álvaro Obregón 120',
      neighborhood: 'Roma Norte',
      city: 'Ciudad de México',
      state: 'Ciudad de México',
      lat: 19.4194,
      lng: -99.1617,
      directoryListed: true,
      settings: {
        ...DEFAULT_TENANT_SETTINGS,
        payments: {
          ...DEFAULT_PAYMENT_SETTINGS,
          transfer: { bank: 'BBVA', accountHolder: 'Nutrición Demo SA de CV', clabe: '012180001234567899' },
          deposit: { enabled: true, type: 'percent', value: 30 },
        },
      },
    })
    .returning();
  const tenantId = tenant!.id;

  const team = await db
    .insert(users)
    .values([
      { tenantId, email: 'demo@agenda.mx', name: 'Dra. Ana López', role: 'owner', passwordHash: await hashPassword('demo1234') },
      { tenantId, email: 'pedro@agenda.mx', name: 'Nut. Pedro Salas', role: 'staff', passwordHash: await hashPassword('demo1234') },
    ])
    .returning();
  const staffIds = team.map((u) => u.id);

  const svc = await db
    .insert(services)
    .values([
      { tenantId, name: 'Consulta inicial', durationMin: 60, priceCents: 70000 },
      { tenantId, name: 'Consulta de seguimiento', durationMin: 30, priceCents: 45000 },
      { tenantId, name: 'Plan alimenticio + bioimpedancia', durationMin: 45, priceCents: 90000 },
    ])
    .returning();

  const names = [
    'María Fernández', 'José Hernández', 'Lucía Martínez', 'Carlos Ramírez', 'Sofía Torres',
    'Diego Morales', 'Valeria Cruz', 'Miguel Ángel Ruiz', 'Fernanda Ortiz', 'Andrés Flores',
    'Daniela Reyes', 'Jorge Castillo', 'Paola Jiménez', 'Ricardo Vargas', 'Camila Mendoza',
    'Luis Navarro', 'Gabriela Silva', 'Alejandro Rojas', 'Ximena Gutiérrez', 'Eduardo Peña',
    'Mariana Aguilar', 'Roberto Medina', 'Natalia Herrera', 'Sergio Domínguez', 'Regina Vázquez',
    'Héctor Castro', 'Andrea Romero', 'Iván Sandoval',
  ];
  const custs = await db
    .insert(customers)
    .values(
      names.map((name, i) => ({
        tenantId,
        name,
        phone: `+52551000${String(1000 + i).slice(-4)}`,
        email: `${name.split(' ')[0]!.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}${i}@example.com`,
        createdAt: DateTime.now().minus({ days: 420 - i * 13 }).toJSDate(),
      })),
    )
    .returning();

  const now = DateTime.now().setZone(TZ);
  const apptValues: (typeof appointments.$inferInsert)[] = [];
  const hours = [9, 10, 11, 12, 13, 16, 17, 18];

  // Past: each customer visits every 2–5 weeks since they signed up
  custs.forEach((c, idx) => {
    let day = DateTime.fromJSDate(c.createdAt).setZone(TZ).startOf('day');
    let first = true;
    while (day < now.startOf('day')) {
      if (day.weekday <= 6) {
        const service = first ? svc[0]! : pick([svc[1]!, svc[1]!, svc[2]!]);
        const start = day.set({ hour: pick(hours), minute: rand() > 0.5 ? 30 : 0 });
        const r = rand();
        const status = r < 0.08 ? 'no_show' : r < 0.13 ? 'cancelled' : 'completed';
        apptValues.push({
          tenantId,
          customerId: c.id,
          serviceId: service.id,
          startsAt: start.toJSDate(),
          endsAt: start.plus({ minutes: service.durationMin }).toJSDate(),
          status,
          priceCents: service.priceCents,
          source: rand() > 0.6 ? 'online' : 'staff',
          staffUserId: pick(staffIds),
          reminderSentAt: start.minus({ hours: 24 }).toJSDate(),
        });
        first = false;
      }
      day = day.plus({ days: 14 + Math.floor(rand() * 21) + (idx % 3) * 3 });
    }
  });

  // Upcoming: next 10 days
  for (let d = 0; d < 10; d++) {
    const day = now.plus({ days: d }).startOf('day');
    if (day.weekday === 7) continue;
    const used = new Set<number>();
    for (let k = 0; k < 3; k++) {
      const h = pick(hours);
      if (used.has(h)) continue;
      used.add(h);
      const start = day.set({ hour: h });
      if (start < now) continue;
      const service = pick(svc);
      apptValues.push({
        tenantId,
        customerId: pick(custs).id,
        serviceId: service.id,
        startsAt: start.toJSDate(),
        endsAt: start.plus({ minutes: service.durationMin }).toJSDate(),
        status: rand() > 0.5 ? 'confirmed' : 'scheduled',
        priceCents: service.priceCents,
        source: rand() > 0.5 ? 'online' : 'staff',
        staffUserId: pick(staffIds),
      });
    }
  }

  const inserted = await db.insert(appointments).values(apptValues).returning();
  const payValues = inserted
    .filter((a) => a.status === 'completed')
    .map((a) => ({
      tenantId,
      customerId: a.customerId,
      appointmentId: a.id,
      amountCents: a.priceCents,
      method: pick(['cash', 'card', 'transfer', 'cash'] as const),
      status: 'paid' as const,
      paidAt: a.endsAt,
    }));
  if (payValues.length) await db.insert(payments).values(payValues);

  console.log(
    `Seeded tenant "${tenant!.name}" with ${custs.length} customers, ${inserted.length} appointments, ${payValues.length} payments`,
  );
  console.log('Login: demo@agenda.mx / demo1234 — public page: /b/nutricion-demo');

  await seedRestaurant();
  await seedBarbershop();
  await seedClasses();
  await seedPadel();
  await seedDirectory();
}

/** Inserts in chunks to stay under Postgres' parameter limit. */
async function insertChunked<T extends Record<string, unknown>>(table: Parameters<ReturnType<typeof getDb>['insert']>[0], rows: T[], size = 400) {
  const db = getDb();
  const out: { id: string; [k: string]: unknown }[] = [];
  for (let i = 0; i < rows.length; i += size) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out.push(...((await db.insert(table).values(rows.slice(i, i + size) as any).returning()) as any));
  }
  return out;
}

async function seedRestaurant() {
  const db = getDb();
  const existing = await db.query.tenants.findFirst({ where: eq(tenants.slug, 'restaurante-demo') });
  if (existing) await db.delete(tenants).where(eq(tenants.id, existing.id));

  const [tenant] = await db
    .insert(tenants)
    .values({
      name: 'La Cocina Demo',
      slug: 'restaurante-demo',
      businessType: 'restaurant',
      phone: '+525598765432',
      timezone: TZ,
      description: 'Cocina mexicana contemporánea. Reserva tu mesa en línea. Cuenta de demostración.',
      address: 'Av. Presidente Masaryk 250',
      neighborhood: 'Polanco',
      city: 'Ciudad de México',
      state: 'Ciudad de México',
      lat: 19.4318,
      lng: -99.1967,
      directoryListed: true,
      settings: {
        ...DEFAULT_TENANT_SETTINGS,
        hours: { days: [2, 3, 4, 5, 6, 7], open: '13:00', close: '23:00', slotMinutes: 30 },
        reservations: { durationMin: 90, maxPartySize: 10 },
        payments: { ...DEFAULT_PAYMENT_SETTINGS },
      },
    })
    .returning();
  const tenantId = tenant!.id;
  await db.insert(users).values({
    tenantId,
    email: 'restaurante@agenda.mx',
    name: 'Chef Luis Ortega',
    role: 'owner',
    passwordHash: await hashPassword('demo1234'),
  });
  const [svc] = await db.insert(services).values({ tenantId, name: 'Reservación', durationMin: 90, priceCents: 0 }).returning();
  const tables = await db
    .insert(diningTables)
    .values([
      { tenantId, name: 'Mesa 1', seats: 2, area: 'Interior' },
      { tenantId, name: 'Mesa 2', seats: 2, area: 'Interior' },
      { tenantId, name: 'Mesa 3', seats: 2, area: 'Terraza' },
      { tenantId, name: 'Mesa 4', seats: 4, area: 'Interior' },
      { tenantId, name: 'Mesa 5', seats: 4, area: 'Interior' },
      { tenantId, name: 'Mesa 6', seats: 4, area: 'Terraza' },
      { tenantId, name: 'Mesa 7', seats: 6, area: 'Terraza' },
      { tenantId, name: 'Mesa 8', seats: 10, area: 'Privado' },
    ])
    .returning();

  const first = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elena', 'Fernando', 'Gabriela', 'Héctor', 'Irene', 'Javier', 'Karla', 'Leonardo', 'Mónica', 'Nicolás', 'Olivia', 'Pablo', 'Renata', 'Santiago', 'Tania', 'Ulises', 'Valeria', 'Xavier', 'Yolanda', 'Zoe'];
  const last = ['García', 'López', 'Martínez', 'Sánchez', 'Ramírez', 'Torres', 'Flores', 'Rivera', 'Gómez', 'Díaz'];
  const custs = await db
    .insert(customers)
    .values(
      Array.from({ length: 60 }, (_, i) => ({
        tenantId,
        name: `${first[i % first.length]} ${last[(i * 7) % last.length]}`,
        phone: `+52552000${String(1000 + i).slice(-4)}`,
        createdAt: DateTime.now().minus({ days: 420 - i * 6 }).toJSDate(),
      })),
    )
    .returning();

  const now = DateTime.now().setZone(TZ);
  const rows: (typeof appointments.$inferInsert)[] = [];
  const sizes = [2, 2, 2, 3, 4, 4, 2, 5, 6, 2, 4, 8];
  const times = [14, 14.5, 15, 15.5, 19, 19.5, 20, 20.5, 21];
  const takenBy = new Map<string, { s: number; e: number }[]>();
  const fits = (tableId: string, s: number, e: number) => !(takenBy.get(tableId) ?? []).some((b) => b.s < e && b.e > s);
  for (let d = -420; d <= 14; d++) {
    const day = now.plus({ days: d }).startOf('day');
    if (day.weekday === 1) continue;
    const perDay = (day.weekday >= 5 ? 9 : 5) + Math.floor(rand() * 4);
    for (let k = 0; k < perDay; k++) {
      const t = pick(times);
      const start = day.set({ hour: Math.floor(t), minute: t % 1 ? 30 : 0 });
      if (d >= 0 && start < now) continue;
      const party = pick(sizes);
      const s0 = start.toMillis();
      const e0 = start.plus({ minutes: 90 }).toMillis();
      const table = [...tables].sort((a, b) => a.seats - b.seats).find((tb) => tb.seats >= party && fits(tb.id, s0, e0));
      if (!table) continue;
      takenBy.set(table.id, [...(takenBy.get(table.id) ?? []), { s: s0, e: e0 }]);
      const r = rand();
      const status = d >= 0 ? (rand() > 0.5 ? 'confirmed' : 'scheduled') : r < 0.07 ? 'no_show' : r < 0.12 ? 'cancelled' : 'completed';
      rows.push({
        tenantId,
        customerId: pick(custs).id,
        serviceId: svc!.id,
        startsAt: start.toJSDate(),
        endsAt: start.plus({ minutes: 90 }).toJSDate(),
        status,
        priceCents: status === 'completed' ? party * (28000 + Math.floor(rand() * 20) * 1000) : 0,
        source: rand() > 0.45 ? 'online' : 'staff',
        partySize: party,
        tableId: table.id,
        reminderSentAt: d < 0 ? start.minus({ hours: 24 }).toJSDate() : null,
      });
    }
  }
  const inserted = (await insertChunked(appointments, rows)) as unknown as (typeof appointments.$inferSelect)[];
  const pays = inserted
    .filter((a) => a.status === 'completed')
    .map((a) => ({
      tenantId,
      customerId: a.customerId,
      appointmentId: a.id,
      amountCents: a.priceCents,
      method: pick(['card', 'card', 'cash', 'transfer'] as const),
      status: 'paid' as const,
      paidAt: a.endsAt,
    }));
  await insertChunked(payments, pays);
  console.log(`Seeded restaurant with ${tables.length} tables, ${inserted.length} reservations — login restaurante@agenda.mx / demo1234`);
}

/** Shared helpers for the extra demos. */
async function resetTenant(slug: string) {
  const db = getDb();
  const existing = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (existing) await db.delete(tenants).where(eq(tenants.id, existing.id));
}

async function demoCustomers(tenantId: string, count: number, phonePrefix: string, sinceDays: number) {
  const first = ['Alejandro', 'Brenda', 'César', 'Daniela', 'Emilio', 'Fátima', 'Gerardo', 'Hilda', 'Iker', 'Jimena', 'Kevin', 'Lorena', 'Mauricio', 'Nadia', 'Óscar', 'Patricia', 'Quique', 'Rocío', 'Samuel', 'Tere', 'Uriel', 'Vanessa', 'Wendy', 'Ximena', 'Yahir', 'Zaira'];
  const last = ['Aguilar', 'Bautista', 'Cervantes', 'Delgado', 'Espinoza', 'Fuentes', 'Guerrero', 'Ibarra', 'Juárez', 'Lara', 'Montes', 'Núñez', 'Osorio', 'Ponce', 'Quiroz', 'Rosales'];
  return (await insertChunked(
    customers,
    Array.from({ length: count }, (_, i) => ({
      tenantId,
      name: `${first[i % first.length]} ${last[(i * 5) % last.length]}`,
      phone: `+52${phonePrefix}${String(10000 + i).slice(-5)}`,
      createdAt: DateTime.now().minus({ days: sinceDays - Math.floor((i * sinceDays) / count) }).toJSDate(),
    })),
  )) as unknown as (typeof customers.$inferSelect)[];
}

async function payCompleted(tenantId: string, rows: (typeof appointments.$inferSelect)[]) {
  const pays = rows
    .filter((a) => a.status === 'completed' && a.priceCents > 0)
    .map((a) => ({
      tenantId,
      customerId: a.customerId,
      appointmentId: a.id,
      amountCents: a.priceCents,
      method: pick(['cash', 'card', 'card', 'transfer'] as const),
      status: 'paid' as const,
      paidAt: a.endsAt,
    }));
  await insertChunked(payments, pays);
  return pays.length;
}

const pastStatus = () => {
  const r = rand();
  return r < 0.06 ? 'no_show' : r < 0.11 ? 'cancelled' : 'completed';
};

/** Barbershop with three barbers, each with their own agenda. */
async function seedBarbershop() {
  const db = getDb();
  await resetTenant('barberia-demo');
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: 'Barbería Demo',
      slug: 'barberia-demo',
      businessType: 'barbershop',
      phone: '+525544332211',
      timezone: TZ,
      description: 'Tres barberos, agenda con quien prefieras. Cuenta de demostración.',
      address: 'Calle Pitágoras 900',
      neighborhood: 'Narvarte Poniente',
      city: 'Ciudad de México',
      state: 'Ciudad de México',
      lat: 19.3962,
      lng: -99.1588,
      directoryListed: true,
      settings: { ...DEFAULT_TENANT_SETTINGS, hours: { days: [1, 2, 3, 4, 5, 6], open: '10:00', close: '20:00', slotMinutes: 30 } },
    })
    .returning();
  const tenantId = tenant!.id;
  const pw = await hashPassword('demo1234');
  const [owner, , memoUser] = await db
    .insert(users)
    .values([
      { tenantId, email: 'barberia@agenda.mx', name: 'Toño Ramírez', role: 'owner', passwordHash: pw },
      { tenantId, email: 'recepcion@agenda.mx', name: 'Karla (Recepción)', role: 'admin', passwordHash: pw },
      { tenantId, email: 'memo@agenda.mx', name: 'Memo Hernández', role: 'staff', passwordHash: pw },
    ])
    .returning();
  const svc = await db
    .insert(services)
    .values([
      { tenantId, name: 'Corte', durationMin: 30, priceCents: 25000 },
      { tenantId, name: 'Corte + barba', durationMin: 60, priceCents: 38000 },
      { tenantId, name: 'Arreglo de barba', durationMin: 30, priceCents: 18000 },
      { tenantId, name: 'Corte niño', durationMin: 30, priceCents: 20000 },
    ])
    .returning();
  const pros = await db
    .insert(professionals)
    .values([
      { tenantId, name: 'Toño', color: '#2563eb', serviceIds: [], userId: owner!.id },
      { tenantId, name: 'Memo', color: '#ea580c', serviceIds: [], userId: memoUser!.id },
      // Luis doesn't do kids' cuts
      { tenantId, name: 'Luis', color: '#16a34a', serviceIds: [svc[0]!.id, svc[1]!.id, svc[2]!.id] },
    ])
    .returning();
  const custs = await demoCustomers(tenantId, 90, '55233', 200);
  const now = DateTime.now().setZone(TZ);
  const rows: (typeof appointments.$inferInsert)[] = [];
  for (let d = -180; d <= 10; d++) {
    const day = now.plus({ days: d }).startOf('day');
    if (day.weekday === 7) continue;
    for (const p of pros) {
      // Each barber fills 40-75% of their day
      let t = day.set({ hour: 10 });
      const close = day.set({ hour: 20 });
      while (t < close) {
        const service = p.name === 'Luis' ? pick(svc.slice(0, 3)) : pick([svc[0]!, svc[0]!, svc[1]!, svc[2]!, svc[3]!]);
        const end = t.plus({ minutes: service.durationMin });
        if (end > close) break;
        if (rand() < (day.weekday >= 5 ? 0.75 : 0.45) && !(d >= 0 && t < now)) {
          rows.push({
            tenantId,
            customerId: pick(custs).id,
            serviceId: service.id,
            professionalId: p.id,
            startsAt: t.toJSDate(),
            endsAt: end.toJSDate(),
            status: d < 0 || t < now ? pastStatus() : rand() > 0.5 ? 'confirmed' : 'scheduled',
            priceCents: service.priceCents,
            source: rand() > 0.5 ? 'online' : 'staff',
            reminderSentAt: d < 0 ? t.minus({ hours: 24 }).toJSDate() : null,
          });
          t = end;
        } else {
          t = t.plus({ minutes: 30 });
        }
      }
    }
  }
  const inserted = (await insertChunked(appointments, rows)) as unknown as (typeof appointments.$inferSelect)[];
  const paid = await payCompleted(tenantId, inserted);
  console.log(`Seeded barbershop with ${pros.length} barbers, ${inserted.length} appointments, ${paid} payments — login barberia@agenda.mx / demo1234`);
}

/** Yoga studio: class types, two instructors, sessions with limited spots. */
async function seedClasses() {
  const db = getDb();
  await resetTenant('yoga-demo');
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: 'Estudio Yoga Demo',
      slug: 'yoga-demo',
      businessType: 'yoga',
      phone: '+525577889900',
      timezone: TZ,
      description: 'Vinyasa, yin y pilates en grupos pequeños. Aparta tu lugar en línea. Cuenta de demostración.',
      address: 'Calle Higuera 40',
      neighborhood: 'Del Carmen, Coyoacán',
      city: 'Ciudad de México',
      state: 'Ciudad de México',
      lat: 19.3467,
      lng: -99.159,
      directoryListed: true,
      settings: { ...DEFAULT_TENANT_SETTINGS, hours: { days: [1, 2, 3, 4, 5, 6], open: '07:00', close: '21:30', slotMinutes: 30 }, selfService: { rescheduleEnabled: true, cancelEnabled: true, minHoursNotice: 4 } },
    })
    .returning();
  const tenantId = tenant!.id;
  const pw = await hashPassword('demo1234');
  const [lauraUser, diegoUser] = await db
    .insert(users)
    .values([
      { tenantId, email: 'clases@agenda.mx', name: 'Laura Méndez', role: 'owner', passwordHash: pw },
      { tenantId, email: 'diego@agenda.mx', name: 'Diego Ruiz', role: 'staff', passwordHash: pw },
    ])
    .returning();
  const [vinyasa, yin, pilates] = await db
    .insert(services)
    .values([
      { tenantId, name: 'Vinyasa', durationMin: 60, priceCents: 18000 },
      { tenantId, name: 'Yin yoga', durationMin: 75, priceCents: 20000 },
      { tenantId, name: 'Pilates mat', durationMin: 50, priceCents: 20000 },
    ])
    .returning();
  const [laura, diego] = await db
    .insert(professionals)
    .values([
      { tenantId, name: 'Laura', color: '#7c3aed', serviceIds: [], userId: lauraUser!.id },
      { tenantId, name: 'Diego', color: '#0f766e', serviceIds: [], userId: diegoUser!.id },
    ])
    .returning();
  // Weekly timetable (created session by session, like a studio would with "copy to next week")
  const timetable: { days: number[]; h: number; m: number; svc: typeof vinyasa; pro: typeof laura; cap: number }[] = [
    { days: [1, 3, 5], h: 7, m: 0, svc: vinyasa, pro: laura, cap: 14 },
    { days: [2, 4], h: 7, m: 0, svc: pilates, pro: diego, cap: 12 },
    { days: [1, 2, 3, 4], h: 19, m: 0, svc: vinyasa, pro: diego, cap: 15 },
    { days: [2, 4], h: 20, m: 15, svc: yin, pro: laura, cap: 12 },
    { days: [6], h: 9, m: 0, svc: vinyasa, pro: laura, cap: 18 },
    { days: [6], h: 10, m: 30, svc: pilates, pro: diego, cap: 12 },
  ];
  const now = DateTime.now().setZone(TZ);
  const sessionRows: (typeof classSessions.$inferInsert)[] = [];
  for (let d = -120; d <= 21; d++) {
    const day = now.plus({ days: d }).startOf('day');
    for (const slot of timetable) {
      if (!slot.days.includes(day.weekday)) continue;
      const start = day.set({ hour: slot.h, minute: slot.m });
      sessionRows.push({
        tenantId,
        serviceId: slot.svc!.id,
        professionalId: slot.pro!.id,
        startsAt: start.toJSDate(),
        endsAt: start.plus({ minutes: slot.svc!.durationMin }).toJSDate(),
        capacity: slot.cap,
      });
    }
  }
  const sessions = (await insertChunked(classSessions, sessionRows)) as unknown as (typeof classSessions.$inferSelect)[];
  const custs = await demoCustomers(tenantId, 70, '55344', 150);
  const price = new Map([vinyasa!, yin!, pilates!].map((s) => [s.id, s.priceCents]));
  const rows: (typeof appointments.$inferInsert)[] = [];
  for (const s of sessions) {
    const past = s.startsAt < now.toJSDate();
    const daysAhead = (s.startsAt.getTime() - now.toMillis()) / 86400e3;
    const fill = past ? 0.45 + rand() * 0.5 : Math.max(0.1, 0.8 - daysAhead * 0.04) * (0.6 + rand() * 0.4);
    const n = Math.min(s.capacity, Math.round(s.capacity * fill));
    const used = new Set<string>();
    for (let k = 0; k < n; k++) {
      const cu = pick(custs);
      if (used.has(cu.id)) continue;
      used.add(cu.id);
      rows.push({
        tenantId,
        customerId: cu.id,
        serviceId: s.serviceId,
        classSessionId: s.id,
        professionalId: s.professionalId,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        partySize: 1,
        status: past ? pastStatus() : rand() > 0.6 ? 'confirmed' : 'scheduled',
        priceCents: price.get(s.serviceId) ?? 0,
        source: rand() > 0.3 ? 'online' : 'staff',
        reminderSentAt: past ? new Date(s.startsAt.getTime() - 24 * 3600e3) : null,
      });
    }
  }
  const inserted = (await insertChunked(appointments, rows)) as unknown as (typeof appointments.$inferSelect)[];
  const paid = await payCompleted(tenantId, inserted);
  console.log(`Seeded yoga studio with ${sessions.length} classes, ${inserted.length} bookings, ${paid} payments — login clases@agenda.mx / demo1234`);
}

/** Padel club renting four courts by the hour. */
async function seedPadel() {
  const db = getDb();
  await resetTenant('padel-demo');
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: 'Pádel Club Demo',
      slug: 'padel-demo',
      businessType: 'sports',
      phone: '+523311223344',
      timezone: TZ,
      description: 'Cuatro canchas de pádel techadas. Reserva por hora en línea. Cuenta de demostración.',
      address: 'Av. Patria 1500',
      neighborhood: 'Puerta de Hierro, Zapopan',
      city: 'Guadalajara',
      state: 'Jalisco',
      lat: 20.7101,
      lng: -103.4106,
      directoryListed: true,
      settings: { ...DEFAULT_TENANT_SETTINGS, hours: { days: [1, 2, 3, 4, 5, 6, 7], open: '07:00', close: '23:00', slotMinutes: 30 }, rentals: { durations: [60, 90, 120] } },
    })
    .returning();
  const tenantId = tenant!.id;
  await db.insert(users).values({ tenantId, email: 'padel@agenda.mx', name: 'Rodrigo Salas', role: 'owner', passwordHash: await hashPassword('demo1234') });
  const [svc] = await db.insert(services).values({ tenantId, name: 'Renta de espacio', durationMin: 60, priceCents: 0 }).returning();
  const courts = await db
    .insert(spaces)
    .values([
      { tenantId, name: 'Cancha 1', pricePerHourCents: 45000, description: 'Techada, cristal' },
      { tenantId, name: 'Cancha 2', pricePerHourCents: 45000, description: 'Techada, cristal' },
      { tenantId, name: 'Cancha 3', pricePerHourCents: 45000, description: 'Techada' },
      { tenantId, name: 'Cancha Central', pricePerHourCents: 55000, description: 'Gradas y mejor iluminación' },
    ])
    .returning();
  const custs = await demoCustomers(tenantId, 80, '33455', 160);
  const now = DateTime.now().setZone(TZ);
  const rows: (typeof appointments.$inferInsert)[] = [];
  for (let d = -150; d <= 14; d++) {
    const day = now.plus({ days: d }).startOf('day');
    const weekend = day.weekday >= 6;
    for (const c of courts) {
      let t = day.set({ hour: 7 });
      const close = day.set({ hour: 23 });
      while (t < close) {
        const dur = pick([60, 90, 90, 120]);
        const end = t.plus({ minutes: dur });
        if (end > close) break;
        const peak = t.hour >= 18 || t.hour < 9 || weekend;
        if (rand() < (peak ? 0.7 : 0.25) && !(d >= 0 && t < now)) {
          rows.push({
            tenantId,
            customerId: pick(custs).id,
            serviceId: svc!.id,
            spaceId: c.id,
            startsAt: t.toJSDate(),
            endsAt: end.toJSDate(),
            status: d < 0 || t < now ? pastStatus() : rand() > 0.5 ? 'confirmed' : 'scheduled',
            priceCents: Math.round((c.pricePerHourCents * dur) / 60),
            source: rand() > 0.35 ? 'online' : 'staff',
            reminderSentAt: d < 0 ? t.minus({ hours: 24 }).toJSDate() : null,
          });
          t = end;
        } else {
          t = t.plus({ minutes: 30 });
        }
      }
    }
  }
  const inserted = (await insertChunked(appointments, rows)) as unknown as (typeof appointments.$inferSelect)[];
  const paid = await payCompleted(tenantId, inserted);
  console.log(`Seeded padel club with ${courts.length} courts, ${inserted.length} bookings, ${paid} payments — login padel@agenda.mx / demo1234`);
}

/** Demo listings for the public directory (clearly labelled "Demo"). */
const DIRECTORY_DEMOS: {
  name: string; type: 'barbershop' | 'beauty_salon' | 'dental' | 'medical' | 'psychology' | 'physiotherapy' | 'spa' | 'cafe' | 'bar' | 'restaurant' | 'veterinary' | 'cosmetology' | 'nutrition';
  neighborhood: string; city: string; state: string; lat: number; lng: number; address: string; desc: string;
  services: [string, number, number][];
}[] = [
  { name: 'Barbería El Güero · Demo', type: 'barbershop', neighborhood: 'Condesa', city: 'Ciudad de México', state: 'Ciudad de México', lat: 19.4116, lng: -99.1718, address: 'Av. Tamaulipas 88', desc: 'Cortes clásicos, fade y arreglo de barba.', services: [['Corte', 40, 25000], ['Corte + barba', 60, 38000]] },
  { name: 'Dental Sonrisa · Demo', type: 'dental', neighborhood: 'Del Valle', city: 'Ciudad de México', state: 'Ciudad de México', lat: 19.3871, lng: -99.1675, address: 'Av. Insurgentes Sur 1100', desc: 'Limpiezas, resinas y ortodoncia.', services: [['Limpieza dental', 45, 70000], ['Valoración', 30, 30000]] },
  { name: 'Consultorio Dra. Ruiz · Demo', type: 'medical', neighborhood: 'Coyoacán', city: 'Ciudad de México', state: 'Ciudad de México', lat: 19.3497, lng: -99.1617, address: 'Calle Francisco Sosa 45', desc: 'Medicina general y certificados médicos.', services: [['Consulta general', 30, 60000]] },
  { name: 'Spa Alma · Demo', type: 'spa', neighborhood: 'Polanco', city: 'Ciudad de México', state: 'Ciudad de México', lat: 19.4337, lng: -99.1904, address: 'Calle Emilio Castelar 70', desc: 'Masajes relajantes y faciales.', services: [['Masaje relajante 60 min', 60, 120000], ['Facial', 50, 90000]] },
  { name: 'Café Tostado · Demo', type: 'cafe', neighborhood: 'Roma Sur', city: 'Ciudad de México', state: 'Ciudad de México', lat: 19.4068, lng: -99.1597, address: 'Calle Medellín 210', desc: 'Café de especialidad y brunch. Reserva tu mesa el fin de semana.', services: [] },
  { name: 'Mezcalería La Doña · Demo', type: 'bar', neighborhood: 'Juárez', city: 'Ciudad de México', state: 'Ciudad de México', lat: 19.4275, lng: -99.1597, address: 'Calle Havre 64', desc: 'Mezcales artesanales y botanas oaxaqueñas.', services: [] },
  { name: 'Psicóloga Marina Vega · Demo', type: 'psychology', neighborhood: 'Narvarte', city: 'Ciudad de México', state: 'Ciudad de México', lat: 19.3956, lng: -99.1547, address: 'Calle Luz Saviñón 500', desc: 'Terapia individual y de pareja, presencial y en línea.', services: [['Sesión individual', 50, 80000]] },
  { name: 'Uñas Bonitas · Demo', type: 'cosmetology', neighborhood: 'Chapultepec', city: 'Guadalajara', state: 'Jalisco', lat: 20.6736, lng: -103.3698, address: 'Av. Chapultepec 300', desc: 'Manicure, pedicure y uñas acrílicas.', services: [['Manicure', 45, 25000], ['Acrílicas', 90, 45000]] },
  { name: 'Taquería Don Chuy · Demo', type: 'restaurant', neighborhood: 'Providencia', city: 'Guadalajara', state: 'Jalisco', lat: 20.6905, lng: -103.3906, address: 'Av. Pablo Neruda 2500', desc: 'Tacos de pastor y birria. Reservaciones para grupos.', services: [] },
  { name: 'Fisio Movimiento · Demo', type: 'physiotherapy', neighborhood: 'San Pedro Garza García', city: 'Monterrey', state: 'Nuevo León', lat: 25.6573, lng: -100.3624, address: 'Calzada del Valle 400', desc: 'Rehabilitación deportiva y terapia física.', services: [['Sesión de fisioterapia', 50, 65000]] },
  { name: 'Salón Glam · Demo', type: 'beauty_salon', neighborhood: 'Centro', city: 'Monterrey', state: 'Nuevo León', lat: 25.6714, lng: -100.3094, address: 'Calle Morelos 800', desc: 'Corte, color y peinados para eventos.', services: [['Corte dama', 60, 35000], ['Tinte', 120, 90000]] },
  { name: 'Veterinaria Patitas · Demo', type: 'veterinary', neighborhood: 'Centro', city: 'Querétaro', state: 'Querétaro', lat: 20.5931, lng: -100.392, address: 'Av. Zaragoza 150', desc: 'Consulta, vacunas y estética canina.', services: [['Consulta', 30, 40000], ['Baño y corte', 90, 35000]] },
  { name: 'Nutrióloga Sofía · Demo', type: 'nutrition', neighborhood: 'Angelópolis', city: 'Puebla', state: 'Puebla', lat: 19.0285, lng: -98.2366, address: 'Blvd. del Niño Poblano 2510', desc: 'Planes de alimentación y seguimiento deportivo.', services: [['Consulta inicial', 60, 60000]] },
  { name: 'Cocina Yucateca · Demo', type: 'restaurant', neighborhood: 'Centro', city: 'Mérida', state: 'Yucatán', lat: 20.9671, lng: -89.6237, address: 'Calle 60 #470', desc: 'Cochinita pibil, papadzules y más. Reserva tu mesa.', services: [] },
];

async function seedDirectory() {
  const db = getDb();
  await db.delete(tenants).where(like(tenants.slug, 'demo-%'));
  for (const [i, d] of DIRECTORY_DEMOS.entries()) {
    const isTables = ['restaurant', 'cafe', 'bar'].includes(d.type);
    const slug = `demo-${d.name.split(' · ')[0]!.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}`;
    const [t] = await db
      .insert(tenants)
      .values({
        name: d.name,
        slug,
        businessType: d.type,
        phone: `+52551111${String(1000 + i).slice(-4)}`,
        timezone: d.state === 'Yucatán' ? 'America/Merida' : d.state === 'Nuevo León' ? 'America/Monterrey' : TZ,
        description: `${d.desc} Negocio de demostración.`,
        address: d.address,
        neighborhood: d.neighborhood,
        city: d.city,
        state: d.state,
        lat: d.lat,
        lng: d.lng,
        directoryListed: true,
        settings: isTables
          ? { ...DEFAULT_TENANT_SETTINGS, hours: { days: [2, 3, 4, 5, 6, 7], open: d.type === 'cafe' ? '08:00' : '13:00', close: d.type === 'cafe' ? '18:00' : '23:00', slotMinutes: 30 } }
          : DEFAULT_TENANT_SETTINGS,
      })
      .returning();
    if (isTables) {
      await db.insert(services).values({ tenantId: t!.id, name: 'Reservación', durationMin: 90, priceCents: 0 });
      await db.insert(diningTables).values([2, 2, 4, 4, 6].map((seats, k) => ({ tenantId: t!.id, name: `Mesa ${k + 1}`, seats })));
    } else {
      await db.insert(services).values(d.services.map(([name, durationMin, priceCents]) => ({ tenantId: t!.id, name, durationMin, priceCents })));
    }
  }
  console.log(`Seeded ${DIRECTORY_DEMOS.length} demo directory listings`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => closeDb());
