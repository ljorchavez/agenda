/**
 * Demo data: `pnpm db:seed`
 * One owner login (demo@agenda.mx / demo1234) for every demo business, switchable in the app:
 * nutrition clinic, restaurant, barbershop with two locations, yoga studio and padel club.
 * Role demos (same password): recepcion@ (admin), gerente@ (Guadalajara manager), memo@ and diego@
 * (team members), pedro@ (nutrition staff). Plus clearly-labelled `demo-*` directory listings.
 */
import { and, eq, inArray, like } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DEFAULT_PAYMENT_SETTINGS, DEFAULT_TENANT_SETTINGS } from '@agenda/shared';
import { hashPassword } from '../lib/auth.js';
import { closeDb, getDb } from './client.js';
import { appointments, classSessions, customers, locations, memberships, payments, resources, services, tenants, users } from './schema.js';

const TZ = 'America/Mexico_City';

type DemoUser = { tenantId: string; email: string; name: string; role: 'owner' | 'admin' | 'staff'; passwordHash: string; locationId?: string | null };

/** One owner for every demo business, so a single session can show them all (business switcher). */
export const DEMO_OWNER = { email: 'demo@agenda.mx', name: 'Jorge Chávez' };
/** Old per-business owner logins, removed in favour of DEMO_OWNER. */
const RETIRED_DEMO_LOGINS = ['barberia@agenda.mx', 'clases@agenda.mx', 'padel@agenda.mx', 'restaurante@agenda.mx'];
let demoOwnerId = '';

async function resetDemoOwner(db: ReturnType<typeof getDb>) {
  await db.delete(users).where(inArray(users.email, [DEMO_OWNER.email, ...RETIRED_DEMO_LOGINS]));
  const [row] = await db
    .insert(users)
    .values({ email: DEMO_OWNER.email, name: DEMO_OWNER.name, passwordHash: await hashPassword('demo1234') })
    .returning();
  demoOwnerId = row!.id;
  return row!;
}

async function addOwner(db: ReturnType<typeof getDb>, tenantId: string) {
  await db.insert(memberships).values({ tenantId, userId: demoOwnerId, role: 'owner' }).onConflictDoNothing();
}

/** Demo logins: recreated on every seed (an account can belong to several businesses through memberships). */
async function addUsers(db: ReturnType<typeof getDb>, list: DemoUser[]) {
  const out: (typeof users.$inferSelect)[] = [];
  for (const u of list) {
    await db.delete(users).where(eq(users.email, u.email));
    const [row] = await db.insert(users).values({ email: u.email, name: u.name, passwordHash: u.passwordHash }).returning();
    await db.insert(memberships).values({ tenantId: u.tenantId, userId: row!.id, role: u.role, locationId: u.locationId ?? null });
    out.push(row!);
  }
  return out;
}

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
  const demoOwner = await resetDemoOwner(db);

  const [tenant] = await db
    .insert(tenants)
    .values({
      name: 'Nutrición Demo',
      slug: 'nutricion-demo',
      businessType: 'nutrition',
      phone: '+525512345678',
      timezone: TZ,
      description: 'Consulta de nutrición, planes alimenticios y bioimpedancia. Cuenta de demostración.',
      address: 'Av. San Fernando 450',
      neighborhood: 'Jardines de la Corregidora',
      city: 'Colima',
      state: 'Colima',
      lat: 19.256,
      lng: -103.718,
      directoryListed: true,
      plan: 'premium',
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

  await addOwner(db, tenantId);
  const team = [
    demoOwner,
    ...(await addUsers(db, [
      { tenantId, email: 'pedro@agenda.mx', name: 'Nut. Pedro Salas', role: 'staff', passwordHash: await hashPassword('demo1234') },
    ])),
  ];
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
  console.log(`All demo businesses are owned by ${DEMO_OWNER.email} / demo1234 (switch between them in the app)`);
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
      address: 'Av. Terranova 1200',
      neighborhood: 'Providencia',
      city: 'Guadalajara',
      state: 'Jalisco',
      lat: 20.696,
      lng: -103.383,
      directoryListed: true,
      plan: 'premium',
      settings: {
        ...DEFAULT_TENANT_SETTINGS,
        hours: { days: [2, 3, 4, 5, 6, 7], open: '13:00', close: '23:00', slotMinutes: 30 },
        reservations: { durationMin: 90, maxPartySize: 10 },
        payments: { ...DEFAULT_PAYMENT_SETTINGS },
      },
    })
    .returning();
  const tenantId = tenant!.id;
  await addOwner(db, tenantId);
  const [svc] = await db.insert(services).values({ tenantId, name: 'Reservación', durationMin: 90, priceCents: 0 }).returning();
  const tables = await db
    .insert(resources)
    .values([
      { tenantId, name: 'Mesa 1', capacity: 2, description: 'Interior', color: '#0f766e' },
      { tenantId, name: 'Mesa 2', capacity: 2, description: 'Interior', color: '#2563eb' },
      { tenantId, name: 'Mesa 3', capacity: 2, description: 'Terraza', color: '#7c3aed' },
      { tenantId, name: 'Mesa 4', capacity: 4, description: 'Interior', color: '#db2777' },
      { tenantId, name: 'Mesa 5', capacity: 4, description: 'Interior', color: '#ea580c' },
      { tenantId, name: 'Mesa 6', capacity: 4, description: 'Terraza', color: '#ca8a04' },
      { tenantId, name: 'Mesa 7', capacity: 6, description: 'Terraza', color: '#16a34a' },
      { tenantId, name: 'Mesa 8', capacity: 10, description: 'Privado', color: '#475569' },
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
      const table = [...tables].sort((a, b) => a.capacity! - b.capacity!).find((tb) => tb.capacity! >= party && fits(tb.id, s0, e0));
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
        resourceId: table.id,
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
  console.log(`Seeded restaurant with ${tables.length} tables, ${inserted.length} reservations`);
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
      description: 'Dos sucursales, agenda con el barbero que prefieras. Cuenta de demostración.',
      address: 'Calle Madero 150',
      neighborhood: 'Centro',
      city: 'Colima',
      state: 'Colima',
      lat: 19.2436,
      lng: -103.7262,
      directoryListed: true,
      plan: 'premium',
      settings: { ...DEFAULT_TENANT_SETTINGS, hours: { days: [1, 2, 3, 4, 5, 6], open: '10:00', close: '20:00', slotMinutes: 30 } },
    })
    .returning();
  const tenantId = tenant!.id;
  const pw = await hashPassword('demo1234');
  // Two locations: the original one in Colima and one in Guadalajara, with its own barber, hours and manager.
  await db.update(locations).set({ name: 'Colima Centro' }).where(and(eq(locations.tenantId, tenantId), eq(locations.isPrimary, true)));
  const [gdl] = await db
    .insert(locations)
    .values({
      tenantId,
      name: 'Guadalajara Chapultepec',
      phone: '+523344332299',
      address: 'Av. Chapultepec 480',
      neighborhood: 'Americana',
      city: 'Guadalajara',
      state: 'Jalisco',
      lat: 20.6712,
      lng: -103.3688,
      hours: { days: [1, 2, 3, 4, 5, 6], open: '11:00', close: '21:00', slotMinutes: 30 },
    })
    .returning();
  await addOwner(db, tenantId);
  const [, memoUser] = await addUsers(db, [
    { tenantId, email: 'recepcion@agenda.mx', name: 'Karla (Recepción)', role: 'admin', passwordHash: pw },
    { tenantId, email: 'memo@agenda.mx', name: 'Memo Hernández', role: 'staff', passwordHash: pw },
    { tenantId, email: 'gerente@agenda.mx', name: 'Andrea (Gerente Guadalajara)', role: 'admin', passwordHash: pw, locationId: gdl!.id },
  ]);
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
    .insert(resources)
    .values([
      { tenantId, name: 'Toño', color: '#2563eb', serviceIds: [] },
      { tenantId, name: 'Memo', color: '#ea580c', serviceIds: [], userId: memoUser!.id },
      // Luis doesn't do kids' cuts
      { tenantId, name: 'Luis', color: '#16a34a', serviceIds: [svc[0]!.id, svc[1]!.id, svc[2]!.id] },
      { tenantId, name: 'Rafa', color: '#9333ea', serviceIds: [], locationId: gdl!.id },
    ])
    .returning();
  const custs = await demoCustomers(tenantId, 90, '55233', 200);
  const now = DateTime.now().setZone(TZ);
  const rows: (typeof appointments.$inferInsert)[] = [];
  for (let d = -180; d <= 10; d++) {
    const day = now.plus({ days: d }).startOf('day');
    if (day.weekday === 7) continue;
    for (const p of pros) {
      // Each barber fills 40-75% of their day (Guadalajara opens 11-21)
      const atGdl = p.locationId === gdl!.id;
      let t = day.set({ hour: atGdl ? 11 : 10 });
      const close = day.set({ hour: atGdl ? 21 : 20 });
      while (t < close) {
        const service = p.name === 'Luis' ? pick(svc.slice(0, 3)) : pick([svc[0]!, svc[0]!, svc[1]!, svc[2]!, svc[3]!]);
        const end = t.plus({ minutes: service.durationMin });
        if (end > close) break;
        if (rand() < (day.weekday >= 5 ? 0.75 : 0.45) && !(d >= 0 && t < now)) {
          rows.push({
            tenantId,
            customerId: pick(custs).id,
            serviceId: service.id,
            resourceId: p.id,
            locationId: p.locationId,
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
  console.log(`Seeded barbershop with ${pros.length} barbers, ${inserted.length} appointments, ${paid} payments`);
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
      address: 'Av. Guadalupe 1100',
      neighborhood: 'Chapalita',
      city: 'Guadalajara',
      state: 'Jalisco',
      lat: 20.6672,
      lng: -103.3995,
      directoryListed: true,
      plan: 'premium',
      settings: { ...DEFAULT_TENANT_SETTINGS, hours: { days: [1, 2, 3, 4, 5, 6], open: '07:00', close: '21:30', slotMinutes: 30 }, selfService: { rescheduleEnabled: true, cancelEnabled: true, minHoursNotice: 4 } },
    })
    .returning();
  const tenantId = tenant!.id;
  const pw = await hashPassword('demo1234');
  await addOwner(db, tenantId);
  const [diegoUser] = await addUsers(db, [
    { tenantId, email: 'diego@agenda.mx', name: 'Diego Ruiz', role: 'staff', passwordHash: pw },
  ]);
  const [vinyasa, yin, pilates] = await db
    .insert(services)
    .values([
      { tenantId, name: 'Vinyasa', durationMin: 60, priceCents: 18000 },
      { tenantId, name: 'Yin yoga', durationMin: 75, priceCents: 20000 },
      { tenantId, name: 'Pilates mat', durationMin: 50, priceCents: 20000 },
    ])
    .returning();
  const [laura, diego] = await db
    .insert(resources)
    .values([
      { tenantId, name: 'Laura', color: '#7c3aed', serviceIds: [] },
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
        resourceId: slot.pro!.id,
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
        resourceId: s.resourceId,
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
  console.log(`Seeded yoga studio with ${sessions.length} classes, ${inserted.length} bookings, ${paid} payments`);
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
      plan: 'premium',
      settings: { ...DEFAULT_TENANT_SETTINGS, hours: { days: [1, 2, 3, 4, 5, 6, 7], open: '07:00', close: '23:00', slotMinutes: 30 }, rentals: { durations: [60, 90, 120] } },
    })
    .returning();
  const tenantId = tenant!.id;
  await addOwner(db, tenantId);
  const [svc] = await db.insert(services).values({ tenantId, name: 'Renta de espacio', durationMin: 60, priceCents: 0 }).returning();
  const courts = await db
    .insert(resources)
    .values([
      { tenantId, name: 'Cancha 1', color: '#2563eb', capacity: 4, pricePerHourCents: 45000, description: 'Techada, cristal' },
      { tenantId, name: 'Cancha 2', color: '#16a34a', capacity: 4, pricePerHourCents: 45000, description: 'Techada, cristal' },
      { tenantId, name: 'Cancha 3', color: '#ea580c', capacity: 4, pricePerHourCents: 45000, description: 'Techada' },
      { tenantId, name: 'Cancha Central', color: '#7c3aed', capacity: 4, pricePerHourCents: 55000, description: 'Gradas y mejor iluminación' },
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
            resourceId: c.id,
            startsAt: t.toJSDate(),
            endsAt: end.toJSDate(),
            status: d < 0 || t < now ? pastStatus() : rand() > 0.5 ? 'confirmed' : 'scheduled',
            priceCents: Math.round((c.pricePerHourCents! * dur) / 60),
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
  console.log(`Seeded padel club with ${courts.length} courts, ${inserted.length} bookings, ${paid} payments`);
}

/** Demo listings for the public directory (clearly labelled "Demo"). */
const DIRECTORY_DEMOS: {
  name: string; type: 'barbershop' | 'beauty_salon' | 'dental' | 'medical' | 'psychology' | 'physiotherapy' | 'spa' | 'cafe' | 'bar' | 'restaurant' | 'veterinary' | 'cosmetology' | 'nutrition';
  neighborhood: string; city: string; state: string; lat: number; lng: number; address: string; desc: string;
  services: [string, number, number][];
}[] = [
  { name: 'Barbería El Güero · Demo', type: 'barbershop', neighborhood: 'Lomas de Circunvalación', city: 'Colima', state: 'Colima', lat: 19.251, lng: -103.7095, address: 'Av. Ignacio Sandoval 1200', desc: 'Cortes clásicos, fade y arreglo de barba.', services: [['Corte', 40, 25000], ['Corte + barba', 60, 38000]] },
  { name: 'Dental Sonrisa · Demo', type: 'dental', neighborhood: 'Chapalita', city: 'Guadalajara', state: 'Jalisco', lat: 20.665, lng: -103.401, address: 'Av. Tepeyac 900', desc: 'Limpiezas, resinas y ortodoncia.', services: [['Limpieza dental', 45, 70000], ['Valoración', 30, 30000]] },
  { name: 'Consultorio Dra. Ruiz · Demo', type: 'medical', neighborhood: 'Centro', city: 'Colima', state: 'Colima', lat: 19.2425, lng: -103.728, address: 'Calle Hidalgo 85', desc: 'Medicina general y certificados médicos.', services: [['Consulta general', 30, 60000]] },
  { name: 'Spa Alma · Demo', type: 'spa', neighborhood: 'Providencia', city: 'Guadalajara', state: 'Jalisco', lat: 20.693, lng: -103.388, address: 'Calle Rubén Darío 1300', desc: 'Masajes relajantes y faciales.', services: [['Masaje relajante 60 min', 60, 120000], ['Facial', 50, 90000]] },
  { name: 'Café Tostado · Demo', type: 'cafe', neighborhood: 'Jardines de Vista Hermosa', city: 'Colima', state: 'Colima', lat: 19.2575, lng: -103.716, address: 'Av. San Fernando 820', desc: 'Café de especialidad y brunch. Reserva tu mesa el fin de semana.', services: [] },
  { name: 'Mezcalería La Doña · Demo', type: 'bar', neighborhood: 'Americana', city: 'Guadalajara', state: 'Jalisco', lat: 20.6745, lng: -103.3655, address: 'Calle Lerdo de Tejada 2100', desc: 'Mezcales artesanales y botanas oaxaqueñas.', services: [] },
  { name: 'Psicóloga Marina Vega · Demo', type: 'psychology', neighborhood: 'El Diezmo', city: 'Colima', state: 'Colima', lat: 19.262, lng: -103.704, address: 'Calle Gabino Barreda 300', desc: 'Terapia individual y de pareja, presencial y en línea.', services: [['Sesión individual', 50, 80000]] },
  { name: 'Uñas Bonitas · Demo', type: 'cosmetology', neighborhood: 'Chapultepec', city: 'Guadalajara', state: 'Jalisco', lat: 20.6736, lng: -103.3698, address: 'Av. Chapultepec 300', desc: 'Manicure, pedicure y uñas acrílicas.', services: [['Manicure', 45, 25000], ['Acrílicas', 90, 45000]] },
  { name: 'Taquería Don Chuy · Demo', type: 'restaurant', neighborhood: 'Providencia', city: 'Guadalajara', state: 'Jalisco', lat: 20.6905, lng: -103.3906, address: 'Av. Pablo Neruda 2500', desc: 'Tacos de pastor y birria. Reservaciones para grupos.', services: [] },
  { name: 'Fisio Movimiento · Demo', type: 'physiotherapy', neighborhood: 'Las Palmas', city: 'Colima', state: 'Colima', lat: 19.248, lng: -103.732, address: 'Av. Felipe Sevilla del Río 450', desc: 'Rehabilitación deportiva y terapia física.', services: [['Sesión de fisioterapia', 50, 65000]] },
  { name: 'Salón Glam · Demo', type: 'beauty_salon', neighborhood: 'Jardines del Bosque', city: 'Guadalajara', state: 'Jalisco', lat: 20.66, lng: -103.387, address: 'Av. Niños Héroes 2800', desc: 'Corte, color y peinados para eventos.', services: [['Corte dama', 60, 35000], ['Tinte', 120, 90000]] },
  { name: 'Veterinaria Patitas · Demo', type: 'veterinary', neighborhood: 'Villa de Álvarez', city: 'Colima', state: 'Colima', lat: 19.269, lng: -103.737, address: 'Av. J. Merced Cabrera 400', desc: 'Consulta, vacunas y estética canina.', services: [['Consulta', 30, 40000], ['Baño y corte', 90, 35000]] },
  { name: 'Nutrióloga Sofía · Demo', type: 'nutrition', neighborhood: 'Ladrón de Guevara', city: 'Guadalajara', state: 'Jalisco', lat: 20.6815, lng: -103.381, address: 'Calle José Guadalupe Zuno 2150', desc: 'Planes de alimentación y seguimiento deportivo.', services: [['Consulta inicial', 60, 60000]] },
  { name: 'Cenaduría Colimota · Demo', type: 'restaurant', neighborhood: 'Centro', city: 'Colima', state: 'Colima', lat: 19.244, lng: -103.7245, address: 'Calle Madero 300', desc: 'Sopitos, tostadas y pozole seco. Reserva tu mesa.', services: [] },
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
        plan: 'standard',
        settings: isTables
          ? { ...DEFAULT_TENANT_SETTINGS, hours: { days: [2, 3, 4, 5, 6, 7], open: d.type === 'cafe' ? '08:00' : '13:00', close: d.type === 'cafe' ? '18:00' : '23:00', slotMinutes: 30 } }
          : DEFAULT_TENANT_SETTINGS,
      })
      .returning();
    if (isTables) {
      await db.insert(services).values({ tenantId: t!.id, name: 'Reservación', durationMin: 90, priceCents: 0 });
      await db.insert(resources).values([2, 2, 4, 4, 6].map((capacity, k) => ({ tenantId: t!.id, name: `Mesa ${k + 1}`, capacity })));
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
