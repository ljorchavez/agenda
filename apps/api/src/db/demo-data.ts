/**
 * Demo data. Run with `pnpm db:seed`, and reset every night by the `/api/cron/reset-demo` job.
 * One owner login (demo@agenda.mx / demo1234) for every demo business, switchable in the app:
 * nutrition clinic, restaurant, barbershop with two locations, yoga studio, padel club, medical practice,
 * dental clinic, psychologist and physiotherapy (health giros with clinical records).
 * Role demos (same password): recepcion@ (admin), gerente@ (Guadalajara manager), memo@ and diego@
 * (team members), pedro@ (nutrition staff). Plus clearly-labelled `demo-*` directory listings.
 */
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { CLINICAL_TEMPLATES, DEFAULT_PAYMENT_SETTINGS, DEFAULT_TENANT_SETTINGS, type FormAnswerValue, type FormField } from '@agenda/shared';
import { hashPassword } from '../lib/auth.js';
import { getDb } from './client.js';
import {
  appointments,
  cashClosings,
  clinicalNotes,
  classSessions,
  coupons,
  customerPlans,
  customerRecords,
  customers,
  forms,
  giftCards,
  locations,
  memberships,
  offerings,
  payments,
  planUses,
  recordNotes,
  resources,
  reviews,
  services,
  tenants,
  users,
} from './schema.js';
import { encryptSecret } from '../lib/crypto.js';
import { saveResponse } from '../lib/forms.js';
import { signatureHash } from '../routes/clinical.js';

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

/** Deletes and recreates every demo business. Real businesses are never touched. */
export async function seedDemo() {
  seed = 42; // same demo every run, even in a warm serverless instance
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
        clinic: { legalName: 'Nutrición Demo SA de CV', healthLicense: null },
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
  const payValues = await seedPayments(tenantId, inserted, { manual: ['cash', 'card', 'transfer', 'cash'] });

  console.log(
    `Seeded tenant "${tenant!.name}" with ${custs.length} customers, ${inserted.length} appointments, ${payValues} payments`,
  );
  console.log('Login: demo@agenda.mx / demo1234 — public page: /b/nutricion-demo');

  await seedRestaurant();
  await seedBarbershop();
  await seedClasses();
  await seedPadel();
  await seedDoctor();
  await seedHealthDemos();
  await seedPageLooks();
  await seedDirectory();
  await seedExtras();
  await seedClinical();
  console.log(`All demo businesses are owned by ${DEMO_OWNER.email} / demo1234 (switch between them in the app)`);
}

/** Social links and a notice on the demo booking pages (pictures are uploaded from Configuración). */
async function seedPageLooks() {
  const db = getDb();
  const looks: Record<string, { instagram?: string; facebook?: string; tiktok?: string; notice?: string }> = {
    'barberia-demo': { instagram: '@barberiademo', tiktok: '@barberiademo', notice: 'Martes de 2x1 en corte niño' },
    'padel-demo': { instagram: '@padelclubdemo', facebook: 'padelclubdemo', notice: 'Torneo relámpago el sábado: inscríbete en recepción' },
    'medico-demo': { facebook: 'consultoriodemo', notice: 'Trae tus estudios previos a tu primera consulta' },
    'yoga-demo': { instagram: '@yogademo', notice: 'Primera clase con 15% usando el cupón BIENVENIDA' },
    'restaurante-demo': { instagram: '@restaurantedemo', notice: 'Grupos de 6 o más: menú especial con anticipo' },
    'nutricion-demo': { instagram: '@nutriciondemo', notice: 'Primera consulta con 15% usando el cupón BIENVENIDA' },
  };
  for (const [slug, page] of Object.entries(looks)) {
    const t = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
    if (!t) continue;
    // Promotions on: a reward every 5 visits and two coupons to try
    await db
      .update(tenants)
      .set({
        settings: {
          ...t.settings,
          page: { gallery: [], ...page },
          rewards: { enabled: true, everyVisits: 5, discountType: 'percent', value: 10 },
          coupons: { enabled: true },
        },
      })
      .where(eq(tenants.id, t.id));
    // BIENVENIDA: once per customer, and only for the first visit where the business has one
    const firstVisit = (await db.select().from(services).where(eq(services.tenantId, t.id))).filter((x) => /inicial|primera vez/i.test(x.name)).map((x) => x.id);
    const [welcome, friend] = await db
      .insert(coupons)
      .values([
        { tenantId: t.id, code: 'BIENVENIDA', discountType: 'percent', value: 15, maxUsesPerCustomer: 1, serviceIds: firstVisit },
        { tenantId: t.id, code: 'AMIGO50', discountType: 'amount', value: 5000, maxUses: 100 },
        { tenantId: t.id, code: 'VERANO20', discountType: 'percent', value: 20, validUntil: DateTime.now().minus({ months: 2 }).toISODate()! },
      ])
      .returning();
    await discountExamples(t.id, welcome!.id, friend!.id);
  }
}

/**
 * Examples of every discount on existing demo bookings, past and upcoming: the visit reward
 * (10%), the BIENVENIDA coupon (15%) and AMIGO50 ($50). Payments that would now exceed the
 * discounted price are trimmed so the money states stay right (paid, deposit, owes).
 */
async function discountExamples(tenantId: string, welcomeId: string, friendId: string) {
  const db = getDb();
  await db.execute(sql`
    with picked as (
      select id, price_cents,
             row_number() over (order by starts_at) as n
      from appointments
      where tenant_id = ${tenantId} and price_cents >= 5000 and status <> 'cancelled'
    ), chosen as (
      select id, price_cents,
             case when n % 13 = 0 then 'reward' when n % 17 = 0 then 'welcome' when n % 29 = 0 then 'friend' end as kind
      from picked
    ), off as (
      select id, kind,
             case kind when 'reward' then round(price_cents * 0.10) when 'welcome' then round(price_cents * 0.15) else least(5000, price_cents) end::int as cents
      from chosen where kind is not null
    )
    update appointments a set
      price_cents = a.price_cents - off.cents,
      discount_cents = off.cents,
      discount_reason = case when off.kind = 'reward' then 'reward' else 'coupon' end,
      coupon_id = case off.kind when 'welcome' then ${welcomeId}::uuid when 'friend' then ${friendId}::uuid end
    from off where a.id = off.id`);
  // Trim what was paid over the new price (the payment made last absorbs the difference).
  await db.execute(sql`
    with over as (
      select a.id, sum(p.amount_cents) - a.price_cents as excess
      from appointments a join payments p on p.appointment_id = a.id and p.status = 'paid'
      where a.tenant_id = ${tenantId} and a.discount_cents > 0
      group by a.id, a.price_cents
      having sum(p.amount_cents) > a.price_cents
    ), last_pay as (
      select distinct on (p.appointment_id) p.id, over.excess, p.amount_cents
      from payments p join over on over.id = p.appointment_id
      where p.status = 'paid'
      order by p.appointment_id, p.paid_at desc
    )
    update payments p set amount_cents = greatest(100, p.amount_cents - last_pay.excess)
    from last_pay where p.id = last_pay.id`);
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
        // Groups of 6+ book a set menu, so the price is known ahead and they can leave a deposit
        priceCents: status === 'completed' ? party * (28000 + Math.floor(rand() * 20) * 1000) : party >= 6 ? party * 35000 : 0,
        source: rand() > 0.45 ? 'online' : 'staff',
        partySize: party,
        resourceId: table.id,
        reminderSentAt: d < 0 ? start.minus({ hours: 24 }).toJSDate() : null,
      });
    }
  }
  const inserted = (await insertChunked(appointments, rows)) as unknown as (typeof appointments.$inferSelect)[];
  // Only groups of 6+ leave a deposit
  await seedPayments(tenantId, inserted, { manual: ['card', 'card', 'cash', 'transfer'], depositIf: (a) => (a.partySize ?? 0) >= 6 });
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

type Method = 'cash' | 'card' | 'transfer';
/**
 * Payments for demo bookings, covering every collection state: online deposits (Mercado Pago),
 * deposits later settled in person, deposits never settled (they owe), unpaid past bookings,
 * prepaid upcoming bookings and no-shows that lost their deposit.
 */
async function seedPayments(
  tenantId: string,
  rows: (typeof appointments.$inferSelect)[],
  opts: { manual: readonly Method[]; depositPct?: number; online?: number; depositIf?: (a: typeof appointments.$inferSelect) => boolean },
) {
  const now = Date.now();
  const pct = opts.depositPct ?? 30;
  const online = opts.online ?? 0.35;
  const pays: (typeof payments.$inferInsert)[] = [];
  const add = (a: (typeof appointments.$inferSelect), amountCents: number, method: Method | 'mercadopago', paidAt: Date) =>
    pays.push({
      tenantId,
      customerId: a.customerId,
      appointmentId: a.id,
      amountCents,
      method,
      status: 'paid',
      provider: method === 'mercadopago' ? 'mercadopago' : null,
      paidAt,
    });
  for (const a of rows) {
    if (a.priceCents <= 0) continue;
    const deposit = Math.max(100, Math.round((a.priceCents * pct) / 10000) * 100);
    const depositAt = new Date(a.startsAt.getTime() - (1 + Math.floor(rand() * 5)) * 86400e3);
    const depositMethod = () => (rand() < 0.75 ? 'mercadopago' : 'transfer');
    const r = rand();
    if (opts.depositIf && !opts.depositIf(a)) {
      if (a.status === 'completed' && r >= 0.04) add(a, a.priceCents, pick(opts.manual), a.endsAt);
      continue;
    }
    if (a.endsAt.getTime() > now && a.status !== 'completed') {
      // Upcoming
      if (a.status === 'cancelled' || a.status === 'no_show') continue;
      if (r < 0.3) add(a, deposit, depositMethod(), new Date(Math.min(depositAt.getTime(), now)));
      else if (r < 0.3 + online * 0.35) add(a, a.priceCents, 'mercadopago', new Date(Math.min(depositAt.getTime(), now)));
      continue;
    }
    if (a.status === 'completed') {
      if (r < 0.06) continue; // never paid: owes everything
      if (r < 0.14) add(a, deposit, depositMethod(), depositAt); // deposit only: owes the balance
      else if (r < 0.14 + online) {
        add(a, deposit, depositMethod(), depositAt);
        add(a, a.priceCents - deposit, pick(opts.manual), a.endsAt);
      } else add(a, a.priceCents, pick(opts.manual), a.endsAt);
    } else if (a.status === 'no_show' && r < 0.4) add(a, deposit, depositMethod(), depositAt);
  }
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
  const paid = await seedPayments(tenantId, inserted, { manual: ['cash', 'card', 'card', 'transfer'] });
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
  const paid = await seedPayments(tenantId, inserted, { manual: ['cash', 'card', 'card', 'transfer'], depositPct: 50, online: 0.5 });
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
  const paid = await seedPayments(tenantId, inserted, { manual: ['cash', 'card', 'card', 'transfer'] });
  console.log(`Seeded padel club with ${courts.length} courts, ${inserted.length} bookings, ${paid} payments`);
}

/** Medical practice: two doctors, first visits with an online deposit, follow-ups and certificates. */
async function seedDoctor() {
  const db = getDb();
  await resetTenant('medico-demo');
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: 'Consultorio Médico Demo',
      slug: 'medico-demo',
      businessType: 'medical',
      phone: '+523121234567',
      timezone: TZ,
      description: 'Medicina general y medicina interna. Consulta de primera vez con anticipo en línea. Cuenta de demostración.',
      address: 'Av. Rey de Colimán 230',
      neighborhood: 'Centro',
      city: 'Colima',
      state: 'Colima',
      lat: 19.2449,
      lng: -103.7241,
      directoryListed: true,
      plan: 'premium',
      settings: {
        ...DEFAULT_TENANT_SETTINGS,
        hours: { days: [1, 2, 3, 4, 5, 6], open: '09:00', close: '19:00', slotMinutes: 30 },
        payments: {
          ...DEFAULT_PAYMENT_SETTINGS,
          transfer: { bank: 'Banorte', accountHolder: 'Consultorio Médico Demo SC', clabe: '072090001234567891' },
          deposit: { enabled: true, type: 'percent', value: 50 },
        },
        clinic: { legalName: 'Consultorio Médico Demo SC', healthLicense: '2506009876' },
      },
    })
    .returning();
  const tenantId = tenant!.id;
  await addOwner(db, tenantId);
  const svc = await db
    .insert(services)
    .values([
      { tenantId, name: 'Consulta de primera vez', durationMin: 45, priceCents: 80000 },
      { tenantId, name: 'Consulta de seguimiento', durationMin: 30, priceCents: 60000 },
      { tenantId, name: 'Certificado médico', durationMin: 20, priceCents: 35000 },
      { tenantId, name: 'Consulta de medicina interna', durationMin: 45, priceCents: 120000 },
    ])
    .returning();
  const docs = await db
    .insert(resources)
    .values([
      { tenantId, name: 'Dra. Valeria Ortiz', color: '#0f766e', description: 'Medicina general', serviceIds: [svc[0]!.id, svc[1]!.id, svc[2]!.id] },
      { tenantId, name: 'Dr. Arturo Méndez', color: '#2563eb', description: 'Medicina interna', serviceIds: [svc[0]!.id, svc[1]!.id, svc[3]!.id] },
    ])
    .returning();
  const custs = await demoCustomers(tenantId, 85, '31212', 300);
  const seen = new Set<string>();
  const now = DateTime.now().setZone(TZ);
  const rows: (typeof appointments.$inferInsert)[] = [];
  for (let d = -240; d <= 14; d++) {
    const day = now.plus({ days: d }).startOf('day');
    if (day.weekday === 7) continue;
    for (const doc of docs) {
      let t = day.set({ hour: 9 });
      const close = day.set({ hour: day.weekday === 6 ? 14 : 19 });
      while (t < close) {
        if (t.hour === 14 && day.weekday !== 6) {
          t = day.set({ hour: 16 }); // lunch break
          continue;
        }
        const cu = pick(custs);
        const firstVisit = !seen.has(cu.id + doc.id);
        const options = (doc.serviceIds ?? []).map((id) => svc.find((s) => s.id === id)!).filter((s) => s.name !== 'Consulta de primera vez');
        const service = firstVisit ? svc[0]! : pick(options);
        const end = t.plus({ minutes: service.durationMin });
        if (end > close) break;
        if (rand() < 0.55 && !(d >= 0 && t < now)) {
          seen.add(cu.id + doc.id);
          rows.push({
            tenantId,
            customerId: cu.id,
            serviceId: service.id,
            resourceId: doc.id,
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
  const paid = await seedPayments(tenantId, inserted, { manual: ['cash', 'card', 'card', 'transfer'], depositPct: 50, online: 0.45 });
  console.log(`Seeded medical practice with ${docs.length} doctors, ${inserted.length} appointments, ${paid} payments`);
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

// ---------- Packages, records, commissions, cash closings and reviews ----------

const REVIEW_TEXTS: [number, string | null][] = [
  [5, 'Excelente servicio, muy puntuales.'],
  [5, 'Me encantó, regreso seguro.'],
  [5, null],
  [4, 'Muy bien, solo tuve que esperar un poco.'],
  [5, 'Súper amables y el lugar muy limpio.'],
  [4, null],
  [5, 'Reservar en línea fue facilísimo.'],
  [3, 'Bien, pero el estacionamiento es complicado.'],
  [5, 'Los recomiendo muchísimo.'],
  [4, 'Buena atención, precio justo.'],
];
const REPLIES = ['¡Gracias por tu visita! Te esperamos pronto.', 'Gracias por tu comentario, ya estamos viendo lo del estacionamiento.'];
const short = (full: string) => {
  const [a = '', b = ''] = full.trim().split(/\s+/);
  return b ? `${a} ${b[0]}.` : a;
};

async function tenantBySlug(slug: string) {
  return getDb().query.tenants.findFirst({ where: eq(tenants.slug, slug) });
}

/** Completed bookings of a business with no payments yet (safe to cover with a package). */
async function unpaidCompleted(tenantId: string, limit: number, serviceIds?: string[]) {
  const res = await getDb().execute<{ id: string; customer_id: string; price_cents: number; starts_at: Date }>(sql`
    select a.id, a.customer_id, a.price_cents, a.starts_at from appointments a
    where a.tenant_id = ${tenantId} and a.status = 'completed' and a.price_cents > 0 and a.discount_cents = 0
      and not exists (select 1 from payments p where p.appointment_id = a.id)
      ${serviceIds?.length ? sql`and a.service_id in (${sql.join(serviceIds.map((x) => sql`${x}::uuid`), sql`, `)})` : sql``}
      and a.starts_at > now() - interval '50 days'
    order by a.starts_at desc limit ${limit}`);
  return res.rows;
}

/** Sells a plan to the customers of `uses` (one plan each) and takes a session per booking. */
async function sellAndUse(tenantId: string, o: typeof offerings.$inferSelect, uses: { id: string; customer_id: string; price_cents: number; starts_at: Date }[], perCustomer: number) {
  const db = getDb();
  const byCustomer = new Map<string, typeof uses>();
  for (const u of uses) byCustomer.set(u.customer_id, [...(byCustomer.get(u.customer_id) ?? []), u]);
  let sold = 0;
  for (const [customerId, list] of byCustomer) {
    const first = DateTime.fromJSDate(new Date(list[list.length - 1]!.starts_at)).setZone(TZ).minus({ days: 3 });
    const expires = o.kind === 'membership' ? first.plus({ months: 1 }).minus({ days: 1 }) : first.plus({ days: (o.validityDays ?? 60) - 1 });
    const [plan] = await db
      .insert(customerPlans)
      .values({
        tenantId, customerId, offeringId: o.id, kind: o.kind, name: o.name, serviceIds: o.serviceIds, sessionsTotal: o.sessions,
        priceCents: o.priceCents, startsOn: first.toISODate()!, expiresOn: expires.toISODate()!, soldBy: demoOwnerId,
      })
      .returning();
    await db.insert(payments).values({
      tenantId, customerId, amountCents: o.priceCents, method: pick(['cash', 'card', 'transfer'] as const), status: 'paid',
      paidAt: first.set({ hour: 11 }).toJSDate(), customerPlanId: plan!.id, notes: o.name,
    });
    for (const u of list.slice(0, perCustomer)) {
      await db.insert(planUses).values({ tenantId, customerPlanId: plan!.id, appointmentId: u.id, sessions: 1, createdBy: demoOwnerId });
      await db.update(appointments).set({ priceCents: 0, discountCents: u.price_cents, discountReason: 'package' }).where(eq(appointments.id, u.id));
    }
    sold++;
  }
  return sold;
}

async function seedExtras() {
  const db = getDb();
  // Packages: yoga and nutrition; membership: padel
  const yoga = await tenantBySlug('yoga-demo');
  if (yoga) {
    const [p10, p5] = await db
      .insert(offerings)
      .values([
        { tenantId: yoga.id, kind: 'package', name: 'Paquete 10 clases', priceCents: 120000, sessions: 10, validityDays: 90 },
        { tenantId: yoga.id, kind: 'package', name: 'Paquete 5 clases', priceCents: 65000, sessions: 5, validityDays: 45 },
        { tenantId: yoga.id, kind: 'membership', name: 'Mensual ilimitado', priceCents: 150000, sessions: null },
      ])
      .returning();
    await sellAndUse(yoga.id, p10!, await unpaidCompleted(yoga.id, 40), 7);
    await sellAndUse(yoga.id, p5!, await unpaidCompleted(yoga.id, 12), 3);
  }
  const nutri = await tenantBySlug('nutricion-demo');
  if (nutri) {
    const svc = await db.select().from(services).where(eq(services.tenantId, nutri.id));
    const follow = svc.filter((x) => /seguimiento/i.test(x.name)).map((x) => x.id);
    const [pk] = await db
      .insert(offerings)
      .values({ tenantId: nutri.id, kind: 'package', name: 'Paquete 4 seguimientos', priceCents: 160000, sessions: 4, validityDays: 120, serviceIds: follow })
      .returning();
    await sellAndUse(nutri.id, pk!, await unpaidCompleted(nutri.id, 8, follow), 2);
    // Client records (no photos): allergies, conditions, consent and dated notes by the owner
    const cs = await db.select().from(customers).where(eq(customers.tenantId, nutri.id)).limit(10);
    const ALLERGY = ['Mariscos', null, 'Lactosa (intolerancia)', null, 'Nuez', null, 'Penicilina', null];
    const COND = ['Hipotiroidismo; levotiroxina 50 mcg', 'Prediabetes', null, 'Hipertensión; losartán', null, 'Colitis', null, 'Ninguno'];
    const NOTES = [
      'Primera consulta: % grasa 31. Plan de 1,800 kcal, aumentar proteína en desayuno.',
      'Seguimiento: bajó 1.8 kg. Ajuste de colaciones, agregar 2 L de agua.',
      'Refiere ansiedad por la noche; cambiar cena a más temprano.',
      'Bioimpedancia: masa muscular estable. Mantener plan dos semanas.',
    ];
    for (const [i, cu] of cs.entries()) {
      await db.insert(customerRecords).values({
        customerId: cu.id, tenantId: nutri.id,
        allergiesEnc: ALLERGY[i % ALLERGY.length] ? encryptSecret(ALLERGY[i % ALLERGY.length]!) : null,
        conditionsEnc: COND[i % COND.length] ? encryptSecret(COND[i % COND.length]!) : null,
        consentAt: DateTime.now().minus({ days: 60 - i }).toJSDate(), consentBy: demoOwnerId, updatedBy: demoOwnerId,
      });
      for (let k = 0; k < 1 + (i % 3); k++) {
        await db.insert(recordNotes).values({
          tenantId: nutri.id, customerId: cu.id, bodyEnc: encryptSecret(NOTES[(i + k) % NOTES.length]!), authorId: demoOwnerId,
          authorName: DEMO_OWNER.name, createdAt: DateTime.now().minus({ days: 40 - k * 14 - i }).toJSDate(),
        });
      }
    }
  }
  const padel = await tenantBySlug('padel-demo');
  if (padel) {
    const [m8] = await db
      .insert(offerings)
      .values([
        { tenantId: padel.id, kind: 'membership', name: 'Membresía 8 horas al mes', priceCents: 280000, sessions: 8 },
        { tenantId: padel.id, kind: 'membership', name: 'Membresía ilimitada', priceCents: 450000, sessions: null },
      ])
      .returning();
    await sellAndUse(padel.id, m8!, await unpaidCompleted(padel.id, 20), 5);
  }
  // Barbershop: commissions, a package, gift cards and two cash closings
  const barber = await tenantBySlug('barberia-demo');
  if (barber) {
    const svc = await db.select().from(services).where(eq(services.tenantId, barber.id));
    const combo = svc.find((x) => /barba/i.test(x.name) && /corte/i.test(x.name));
    const team = await db.select().from(resources).where(eq(resources.tenantId, barber.id));
    for (const [i, r] of team.entries()) {
      await db
        .update(resources)
        .set({ commissionPct: String([40, 45, 35, 40][i % 4]), commissionByService: combo && i === 0 ? { [combo.id]: 50 } : {} })
        .where(eq(resources.id, r.id));
    }
    const cuts = svc.filter((x) => /^corte$/i.test(x.name)).map((x) => x.id);
    const [p5] = await db
      .insert(offerings)
      .values({ tenantId: barber.id, kind: 'package', name: '5 cortes', priceCents: 100000, sessions: 5, validityDays: 90, serviceIds: cuts })
      .returning();
    await sellAndUse(barber.id, p5!, await unpaidCompleted(barber.id, 9, cuts), 3);
    const someCustomers = await db.select().from(customers).where(eq(customers.tenantId, barber.id)).limit(3);
    for (const [i, cu] of someCustomers.entries()) {
      const code = ['REGALO24', 'CUMPLE50', 'PAPA2026'][i]!;
      const amount = [50000, 30000, 80000][i]!;
      const [g] = await db
        .insert(giftCards)
        .values({ tenantId: barber.id, code, initialCents: amount, balanceCents: i === 1 ? 5000 : amount, customerId: cu.id, recipientName: ['Para Javier', 'Para Rodrigo', 'Para mi papá'][i], soldBy: demoOwnerId })
        .returning();
      await db.insert(payments).values({ tenantId: barber.id, customerId: cu.id, amountCents: amount, method: 'card', status: 'paid', paidAt: DateTime.now().minus({ days: 10 + i }).toJSDate(), soldGiftCardId: g!.id, notes: `Tarjeta de regalo ${code}` });
    }
    // Cash closings for the last two days at each location
    const locs = await db.select().from(locations).where(eq(locations.tenantId, barber.id));
    for (const l of locs) {
      for (const back of [1, 2]) {
        const day = DateTime.now().setZone(TZ).minus({ days: back });
        const res = await db.execute<{ method: string; total: string }>(sql`
          select p.method::text as method, sum(p.amount_cents) as total from payments p left join appointments a on a.id = p.appointment_id
          where p.tenant_id = ${barber.id} and p.status = 'paid' and coalesce(p.location_id, a.location_id) = ${l.id}
            and p.paid_at >= ${day.startOf('day').toJSDate()} and p.paid_at <= ${day.endOf('day').toJSDate()}
          group by 1`);
        const byMethod: Record<string, number> = { cash: 0, card: 0, transfer: 0, mercadopago: 0, spei: 0, gift_card: 0 };
        for (const r of res.rows) byMethod[r.method] = Number(r.total);
        const expected = byMethod.cash ?? 0;
        await db.insert(cashClosings).values({
          tenantId: barber.id, locationId: l.id, day: day.toISODate()!, byMethod, salesCents: 0, expectedCashCents: expected,
          countedCashCents: back === 1 ? expected : Math.max(0, expected - 5000), notes: back === 1 ? null : 'Faltaron $50 de cambio',
          closedBy: demoOwnerId, closedByName: DEMO_OWNER.name, createdAt: day.set({ hour: 21 }).toJSDate(),
        });
      }
    }
  }
  await seedForms();
  await seedReviews();
}

/**
 * Questionnaires filled by the team during the appointment: nutrition "Historia clínica nutricional"
 * and the doctor's "Antecedentes médicos", each reused on two booking types, with answers.
 */
async function seedForms() {
  const db = getDb();
  const specs: { slug: string; name: string; description: string; services: string[]; fields: FormField[]; answers: Record<string, FormAnswerValue>[] }[] = [
    {
      slug: 'nutricion-demo',
      name: 'Historia clínica nutricional',
      description: 'Se llena con el paciente en la primera consulta.',
      services: ['Consulta inicial', 'Plan alimenticio + bioimpedancia'],
      fields: [
        { id: 'objetivo', label: '¿Cuál es tu objetivo principal?', type: 'choice', required: true, options: ['Bajar de peso', 'Subir masa muscular', 'Rendimiento deportivo', 'Control de glucosa', 'Comer mejor'], help: null },
        { id: 'alergias', label: '¿Tienes alergias o intolerancias a algún alimento?', type: 'text', required: false, options: [], help: 'Ej. lactosa, gluten, mariscos' },
        { id: 'ejercicio', label: '¿Haces ejercicio?', type: 'yesno', required: true, options: [], help: null },
        { id: 'dias', label: '¿Cuántos días a la semana?', type: 'number', required: false, options: [], help: null },
        { id: 'comidas', label: '¿Qué comidas haces al día?', type: 'multi', required: false, options: ['Desayuno', 'Colación', 'Comida', 'Cena'], help: null },
        { id: 'notas', label: '¿Algo más que debamos saber?', type: 'longtext', required: false, options: [], help: null },
      ],
      answers: [
        { objetivo: 'Bajar de peso', alergias: 'Lactosa', ejercicio: true, dias: 3, comidas: ['Desayuno', 'Comida', 'Cena'], notas: 'Trabajo de noche dos veces por semana.' },
        { objetivo: 'Rendimiento deportivo', alergias: '', ejercicio: true, dias: 5, comidas: ['Desayuno', 'Colación', 'Comida', 'Cena'], notas: 'Corro medio maratón en marzo.' },
        { objetivo: 'Control de glucosa', alergias: 'Ninguna', ejercicio: false, dias: null, comidas: ['Desayuno', 'Comida'], notas: '' },
      ],
    },
    {
      slug: 'medico-demo',
      name: 'Antecedentes médicos',
      description: 'Se llena con el paciente al inicio de la consulta.',
      services: ['Consulta de primera vez', 'Consulta de medicina interna'],
      fields: [
        { id: 'motivo', label: 'Motivo de la consulta', type: 'longtext', required: true, options: [], help: null },
        { id: 'cronicas', label: '¿Padeces alguna de estas?', type: 'multi', required: false, options: ['Diabetes', 'Hipertensión', 'Asma', 'Tiroides', 'Ninguna'], help: null },
        { id: 'medicamentos', label: 'Medicamentos que tomas actualmente', type: 'text', required: false, options: [], help: null },
        { id: 'alergiamed', label: '¿Eres alérgico a algún medicamento?', type: 'yesno', required: true, options: [], help: null },
        { id: 'cirugia', label: 'Fecha de tu última cirugía (si aplica)', type: 'date', required: false, options: [], help: null },
      ],
      answers: [
        { motivo: 'Dolor de cabeza frecuente desde hace dos semanas.', cronicas: ['Hipertensión'], medicamentos: 'Losartán 50 mg', alergiamed: false, cirugia: null },
        { motivo: 'Chequeo anual y revisión de estudios de laboratorio.', cronicas: ['Ninguna'], medicamentos: '', alergiamed: true, cirugia: '2021-06-14' },
        { motivo: 'Tos que no se quita.', cronicas: ['Asma'], medicamentos: 'Salbutamol', alergiamed: false, cirugia: null },
      ],
    },
  ];
  for (const sp of specs) {
    const t = await tenantBySlug(sp.slug);
    if (!t) continue;
    const svc = (await db.select().from(services).where(eq(services.tenantId, t.id))).filter((s) => sp.services.includes(s.name));
    if (!svc.length) continue;
    const [form] = await db.insert(forms).values({ tenantId: t.id, name: sp.name, description: sp.description, fields: sp.fields, serviceIds: svc.map((s) => s.id) }).returning();
    const res = await db.execute<{ id: string; customer_id: string }>(sql`
      select distinct on (a.customer_id) a.id, a.customer_id from appointments a
      where a.tenant_id = ${t.id} and a.service_id = ${svc.find((x) => x.name === sp.services[0])?.id ?? svc[0]!.id} and a.status in ('completed', 'scheduled', 'confirmed')
      order by a.customer_id, a.starts_at desc limit 6`);
    for (const [i, a] of res.rows.entries()) {
      await saveResponse(db, { tenantId: t.id, customerId: a.customer_id, appointmentId: a.id, form: form!, values: sp.answers[i % sp.answers.length]!, source: 'staff', authorName: DEMO_OWNER.name });
    }
  }
}

/** Verified reviews on every business in the directory (on completed bookings). */
async function seedReviews() {
  const db = getDb();
  // Only demo businesses (never real ones that are also in the directory)
  const listed = (await db.select().from(tenants).where(eq(tenants.directoryListed, true))).filter((t) => t.slug.endsWith('-demo') || t.slug.startsWith('demo-'));
  for (const [ti, t] of listed.entries()) {
    let done = await db.execute<{ id: string; customer_id: string; location_id: string; name: string; starts_at: Date }>(sql`
      select a.id, a.customer_id, a.location_id, cu.name, a.starts_at from appointments a join customers cu on cu.id = a.customer_id
      where a.tenant_id = ${t.id} and a.status = 'completed' order by a.starts_at desc limit 40`);
    if (!done.rows.length) {
      // Directory-only demos: a few past visits to hang the reviews on
      const svc = await db.query.services.findFirst({ where: eq(services.tenantId, t.id) });
      const loc = await db.query.locations.findFirst({ where: eq(locations.tenantId, t.id) });
      if (!svc || !loc) continue;
      const names = ['Ana Torres', 'Luis Medina', 'Karla Ruiz', 'Diego Salas', 'Sofía Rangel'];
      for (const [k, name] of names.slice(0, 3 + (ti % 3)).entries()) {
        const [cu] = await db.insert(customers).values({ tenantId: t.id, name, phone: `+52331999${String(ti * 10 + k).padStart(4, '0')}` }).returning();
        const at = DateTime.now().setZone(TZ).minus({ days: 5 + k * 9 }).set({ hour: 12, minute: 0 });
        await db.insert(appointments).values({ tenantId: t.id, customerId: cu!.id, serviceId: svc.id, locationId: loc.id, startsAt: at.toJSDate(), endsAt: at.plus({ minutes: svc.durationMin }).toJSDate(), status: 'completed', priceCents: svc.priceCents, source: 'online' });
      }
      done = await db.execute(sql`
        select a.id, a.customer_id, a.location_id, cu.name, a.starts_at from appointments a join customers cu on cu.id = a.customer_id
        where a.tenant_id = ${t.id} and a.status = 'completed' order by a.starts_at desc limit 40`);
    }
    const seen = new Set<string>();
    const howMany = 3 + ((ti * 7) % 6);
    let n = 0;
    for (const a of done.rows) {
      if (n >= howMany || seen.has(a.customer_id)) continue;
      seen.add(a.customer_id);
      const [rating, comment] = REVIEW_TEXTS[(ti + n) % REVIEW_TEXTS.length]!;
      const created = DateTime.fromJSDate(new Date(a.starts_at)).plus({ hours: 5 }).toJSDate();
      await db.insert(reviews).values({
        tenantId: t.id, appointmentId: a.id, customerId: a.customer_id, locationId: a.location_id, authorName: short(a.name), rating, comment,
        reply: n === 0 ? REPLIES[0]! : rating === 3 ? REPLIES[1]! : null, repliedAt: n === 0 || rating === 3 ? created : null,
        hidden: false, createdAt: created,
      });
      n++;
    }
    // One offensive review hidden by the business, to show moderation
    if (t.slug === 'barberia-demo') {
      const a = done.rows.find((x) => !seen.has(x.customer_id));
      if (a) await db.insert(reviews).values({ tenantId: t.id, appointmentId: a.id, customerId: a.customer_id, locationId: a.location_id, authorName: short(a.name), rating: 1, comment: 'Comentario ofensivo (oculto por el negocio).', hidden: true });
    }
  }
  console.log(`Seeded packages, records, commissions, cash closings and reviews`);
}

// ---------- Health giros: dentist, psychologist, physiotherapist and their clinical records ----------

/** Practice with one or two practitioners: first visits, follow-ups and payments. */
async function seedPractice(o: {
  slug: string; name: string; type: 'dental' | 'psychology' | 'physiotherapy'; desc: string; address: string; neighborhood: string;
  lat: number; lng: number; phone: string; services: [string, number, number][]; pros: [string, string, string][]; perDay: number;
}) {
  const db = getDb();
  await resetTenant(o.slug);
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: o.name, slug: o.slug, businessType: o.type, phone: o.phone, timezone: TZ, description: o.desc,
      address: o.address, neighborhood: o.neighborhood, city: 'Colima', state: 'Colima', lat: o.lat, lng: o.lng,
      directoryListed: true, plan: 'premium',
      settings: {
        ...DEFAULT_TENANT_SETTINGS,
        hours: { days: [1, 2, 3, 4, 5, 6], open: '09:00', close: '19:00', slotMinutes: 30 },
        payments: { ...DEFAULT_PAYMENT_SETTINGS, deposit: { enabled: true, type: 'percent', value: 30 } },
        clinic: { legalName: `${o.name.replace(' Demo', '')} SC`, healthLicense: '2506001234' },
      },
    })
    .returning();
  const tenantId = tenant!.id;
  await addOwner(db, tenantId);
  const svc = await db.insert(services).values(o.services.map(([name, durationMin, priceCents]) => ({ tenantId, name, durationMin, priceCents }))).returning();
  const pros = await db.insert(resources).values(o.pros.map(([name, color, description]) => ({ tenantId, name, color, description }))).returning();
  const custs = await demoCustomers(tenantId, 45, o.phone.slice(3, 8), 240);
  const seen = new Set<string>();
  const now = DateTime.now().setZone(TZ);
  const rows: (typeof appointments.$inferInsert)[] = [];
  for (let d = -180; d <= 14; d++) {
    const day = now.plus({ days: d }).startOf('day');
    if (day.weekday === 7) continue;
    for (const pro of pros) {
      for (let k = 0; k < o.perDay; k++) {
        if (rand() < 0.35) continue;
        const start = day.set({ hour: [9, 10, 11, 12, 16, 17, 18][(k * 3 + pro.name.length) % 7]! });
        if (d >= 0 && start < now) continue;
        const cu = pick(custs);
        const service = seen.has(cu.id) ? pick(svc.slice(1)) : svc[0]!;
        seen.add(cu.id);
        rows.push({
          tenantId, customerId: cu.id, serviceId: service.id, resourceId: pro.id,
          startsAt: start.toJSDate(), endsAt: start.plus({ minutes: service.durationMin }).toJSDate(),
          status: start < now ? pastStatus() : rand() > 0.5 ? 'confirmed' : 'scheduled',
          priceCents: service.priceCents, source: rand() > 0.5 ? 'online' : 'staff',
        });
      }
    }
  }
  // One booking per practitioner and hour
  const unique = [...new Map(rows.map((r) => [`${r.resourceId}${(r.startsAt as Date).toISOString()}`, r])).values()];
  const inserted = (await insertChunked(appointments, unique)) as unknown as (typeof appointments.$inferSelect)[];
  const paid = await seedPayments(tenantId, inserted, { manual: ['cash', 'card', 'transfer'], depositPct: 30, online: 0.4 });
  console.log(`Seeded ${o.name} with ${inserted.length} appointments, ${paid} payments`);
}

async function seedHealthDemos() {
  await seedPractice({
    slug: 'dental-demo', name: 'Clínica Dental Demo', type: 'dental', phone: '+523121112233',
    desc: 'Odontología general, endodoncia y ortodoncia. Expediente clínico conforme a la NOM-013. Cuenta de demostración.',
    address: 'Av. Constitución 1450', neighborhood: 'Residencial Esmeralda', lat: 19.2615, lng: -103.7105,
    services: [['Valoración y limpieza', 60, 70000], ['Resina', 45, 90000], ['Endodoncia', 90, 350000], ['Ajuste de ortodoncia', 30, 60000]],
    pros: [['Dra. Mónica Lara', '#0891b2', 'Odontología general'], ['Dr. Felipe Rosas', '#7c3aed', 'Endodoncia y ortodoncia']], perDay: 4,
  });
  await seedPractice({
    slug: 'psicologia-demo', name: 'Consultorio de Psicología Demo', type: 'psychology', phone: '+523122223344',
    desc: 'Terapia individual, de pareja y para adolescentes. Presencial y en línea. Cuenta de demostración.',
    address: 'Calle Venustiano Carranza 820', neighborhood: 'Jardines de Vista Hermosa', lat: 19.2555, lng: -103.7152,
    services: [['Primera sesión (valoración)', 60, 90000], ['Sesión individual', 50, 80000], ['Terapia de pareja', 60, 110000]],
    pros: [['Psic. Andrea Solís', '#db2777', 'Terapia cognitivo-conductual']], perDay: 5,
  });
  await seedPractice({
    slug: 'fisioterapia-demo', name: 'Fisioterapia Demo', type: 'physiotherapy', phone: '+523123334455',
    desc: 'Rehabilitación deportiva, columna y postoperatorio. Cuenta de demostración.',
    address: 'Av. Tecnológico 330', neighborhood: 'Lomas de Circunvalación', lat: 19.2528, lng: -103.703,
    services: [['Valoración fisioterapéutica', 60, 70000], ['Sesión de fisioterapia', 50, 55000], ['Punción seca', 40, 60000]],
    pros: [['L.F.T. Ramón Iñiguez', '#ea580c', 'Rehabilitación deportiva'], ['L.F.T. Carla Peña', '#16a34a', 'Columna y postura']], perDay: 5,
  });
}

/** A signature drawn on screen (SVG data URL, enough for the demo). */
const scribble = (seedN: number) => {
  const pts = Array.from({ length: 9 }, (_, i) => `${10 + i * 22},${30 + Math.round(Math.sin(i * 1.7 + seedN) * 14)}`).join(' ');
  return `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><polyline points="${pts}" fill="none" stroke="#1e293b" stroke-width="2"/></svg>`).toString('base64')}`;
};

const CASES: Record<'medical' | 'dental' | 'psychology' | 'physiotherapy' | 'nutrition', { history: Record<string, unknown>; evolutions: Record<string, unknown>[] }[]> = {
  medical: [
    {
      history: {
        ocupacion: 'Contadora', estadoCivil: 'Casado(a)', escolaridad: 'Licenciatura', tipoSangre: 'O+',
        heredofamiliares: 'Madre con diabetes mellitus tipo 2. Padre con hipertensión arterial.',
        patologicos: 'Niega cirugías y hospitalizaciones.', alergias: 'Penicilina', medicamentosActuales: 'Ninguno', tabaco: 'Nunca', alcohol: 'Ocasional',
        noPatologicos: 'Sedentaria, dieta alta en carbohidratos. Esquema de vacunación completo.',
        padecimientoActual: 'Refiere poliuria y polidipsia de 3 meses de evolución, cansancio por las tardes. Glucosa capilar en farmacia de 210 mg/dL.',
        habitus: 'Consciente, orientada, bien hidratada.', signos: { ta: '130/85', fc: 78, fr: 16, temp: 36.6, spo2: 97, peso: 82, talla: 162 },
        cabeza: 'Sin alteraciones', cuello: 'Sin adenomegalias', torax: 'Campos pulmonares bien ventilados', abdomen: 'Globoso, blando, no doloroso', miembros: 'Sin edema',
        resultados: 'Glucosa en ayuno 168 mg/dL, HbA1c 7.9 %.',
        diagnosticos: [{ code: 'E11.9', text: 'Diabetes mellitus tipo 2 sin complicaciones' }, { code: 'E66.9', text: 'Obesidad' }],
        pronostico: 'Bueno para la vida, reservado para la función si no hay apego.',
        medicamentos: [{ name: 'Metformina 850 mg', dose: '1 tableta', route: 'Oral', frequency: 'Cada 12 horas con alimentos', duration: '30 días' }],
        indicaciones: 'Plan de alimentación, caminata 30 minutos diarios. Glucosa en ayuno y HbA1c en 3 meses.',
      },
      evolutions: [
        {
          evolucion: 'Refiere mejoría de la poliuria. Buen apego a metformina, leve molestia gástrica la primera semana.',
          signos: { ta: '125/80', fc: 74, peso: 79.5, talla: 162 }, resultados: 'Glucosa capilar en ayuno 132 mg/dL.',
          diagnosticos: [{ code: 'E11.9', text: 'Diabetes mellitus tipo 2 en control' }], pronostico: 'Bueno',
          medicamentos: [{ name: 'Metformina 850 mg', dose: '1 tableta', route: 'Oral', frequency: 'Cada 12 horas', duration: '90 días' }],
          indicaciones: 'Continuar tratamiento. Cita en 3 meses con HbA1c.',
        },
      ],
    },
    {
      history: {
        ocupacion: 'Maestro', estadoCivil: 'Casado(a)', tipoSangre: 'A+', heredofamiliares: 'Padre con infarto a los 60 años.',
        patologicos: 'Apendicectomía a los 20 años.', alergias: 'Negadas', tabaco: 'Exfumador(a)', alcohol: 'Ocasional',
        padecimientoActual: 'Cefalea occipital de predominio matutino de 2 semanas. Cifras de 150/95 en casa.',
        signos: { ta: '150/95', fc: 82, fr: 16, temp: 36.4, spo2: 98, peso: 88, talla: 175 },
        cabeza: 'Sin alteraciones', torax: 'Ruidos cardiacos rítmicos', abdomen: 'Cicatriz en fosa iliaca derecha', miembros: 'Pulsos presentes',
        diagnosticos: [{ code: 'I10', text: 'Hipertensión arterial sistémica' }], pronostico: 'Bueno con tratamiento',
        medicamentos: [{ name: 'Losartán 50 mg', dose: '1 tableta', route: 'Oral', frequency: 'Cada 24 horas', duration: '30 días' }],
        indicaciones: 'Dieta baja en sodio, registro de presión en casa, perfil de lípidos y química sanguínea.',
      },
      evolutions: [
        {
          evolucion: 'Sin cefalea. Registro en casa promedio 128/82.', signos: { ta: '128/82', fc: 72 }, resultados: 'Colesterol total 215 mg/dL, LDL 140 mg/dL.',
          diagnosticos: [{ code: 'I10', text: 'Hipertensión arterial en control' }, { code: 'E78.0', text: 'Hipercolesterolemia' }], pronostico: 'Bueno',
          medicamentos: [{ name: 'Losartán 50 mg', dose: '1 tableta', route: 'Oral', frequency: 'Cada 24 horas', duration: '90 días' }],
          indicaciones: 'Continuar losartán. Dieta baja en grasas saturadas. Control en 3 meses.',
        },
      ],
    },
  ],
  dental: [
    {
      history: {
        ocupacion: 'Estudiante', estadoCivil: 'Soltero(a)', tipoSangre: 'O+', heredofamiliares: 'Sin importancia', alergias: 'Negadas', tabaco: 'Nunca', alcohol: 'No',
        motivo: 'Dolor al masticar del lado derecho', padecimientoActual: 'Dolor a estímulos fríos en molar superior derecho de 1 mes, sin dolor nocturno.',
        signos: { ta: '110/70', fc: 70 }, cabezaCuello: 'Sin alteraciones', atm: 'Sin chasquidos ni dolor', tejidosBlandos: 'Sin lesiones', encias: 'Inflamación leve en zona posterior', oclusion: 'Clase I', higiene: 'Regular',
        odontograma: { '16': { state: 'caries', surfaces: ['O', 'D'] }, '26': { state: 'obturado', surfaces: ['O'] }, '36': { state: 'caries', surfaces: ['O'] }, '18': { state: 'ausente' }, '48': { state: 'extraccion' } },
        resultados: 'Radiografía periapical 16: caries en dentina sin compromiso pulpar.',
        diagnosticos: [{ code: 'K02.1', text: 'Caries de la dentina (16, 36)' }, { code: 'K05.1', text: 'Gingivitis crónica' }],
        pronostico: 'Favorable', plan: '1. Profilaxis. 2. Resinas en 16 y 36. 3. Valorar extracción del 48 (tercer molar).',
      },
      evolutions: [
        {
          procedimiento: 'Profilaxis y resina en 16 (O-D) con aislamiento absoluto.', piezas: '16', anestesia: 'Lidocaína 2 % con epinefrina, 1 cartucho', materiales: 'Resina A2, adhesivo universal',
          odontograma: { '16': { state: 'obturado', surfaces: ['O', 'D'] }, '26': { state: 'obturado', surfaces: ['O'] }, '36': { state: 'caries', surfaces: ['O'] }, '18': { state: 'ausente' }, '48': { state: 'extraccion' } },
          indicaciones: 'No comer en 2 horas. Técnica de cepillado e hilo dental.', proxima: 'Resina en 36',
        },
        {
          procedimiento: 'Resina en 36 (O).', piezas: '36', anestesia: 'Lidocaína 2 %, 1 cartucho', materiales: 'Resina A2',
          odontograma: { '16': { state: 'obturado', surfaces: ['O', 'D'] }, '26': { state: 'obturado', surfaces: ['O'] }, '36': { state: 'obturado', surfaces: ['O'] }, '18': { state: 'ausente' }, '48': { state: 'extraccion' } },
          indicaciones: 'Control en 6 meses.', proxima: 'Valoración de tercer molar',
        },
      ],
    },
    {
      history: {
        ocupacion: 'Comerciante', estadoCivil: 'Casado(a)', tipoSangre: 'B+', patologicos: 'Hipertensión controlada con losartán', alergias: 'Negadas', medicamentosActuales: 'Losartán 50 mg',
        motivo: 'Dolor intenso en muela inferior izquierda', padecimientoActual: 'Dolor espontáneo y nocturno de 4 días en 36, no cede con analgésicos.',
        signos: { ta: '135/85', fc: 80 }, tejidosBlandos: 'Sin aumento de volumen', encias: 'Sin bolsas', oclusion: 'Clase II', higiene: 'Deficiente',
        odontograma: { '36': { state: 'caries', surfaces: ['O', 'M', 'D'] }, '46': { state: 'corona' }, '17': { state: 'endodoncia' }, '27': { state: 'ausente' } },
        resultados: 'Radiografía: caries profunda en 36 con compromiso pulpar.', diagnosticos: [{ code: 'K04.0', text: 'Pulpitis irreversible (36)' }],
        pronostico: 'Favorable con endodoncia', plan: 'Endodoncia en 36 y corona. Profilaxis.',
      },
      evolutions: [
        {
          procedimiento: 'Endodoncia en 36: acceso, conductometría, instrumentación rotatoria y obturación.', piezas: '36', anestesia: 'Articaína 4 %, 2 cartuchos', materiales: 'Gutapercha, cemento sellador',
          odontograma: { '36': { state: 'endodoncia' }, '46': { state: 'corona' }, '17': { state: 'endodoncia' }, '27': { state: 'ausente' } },
          indicaciones: 'Ibuprofeno 400 mg cada 8 horas por 3 días si hay dolor. Evitar masticar del lado izquierdo hasta colocar corona.', proxima: 'Toma de impresión para corona',
        },
      ],
    },
  ],
  psychology: [
    {
      history: {
        ocupacion: 'Diseñadora', estadoCivil: 'Soltero(a)', escolaridad: 'Licenciatura',
        motivo: '"Me siento con mucha presión en el trabajo y no puedo dormir."', historiaProblema: 'Inicia hace 4 meses con cambio de puesto. Insomnio de conciliación y preocupación constante.',
        tratamientosPrevios: 'Ninguno', heredofamiliares: 'Madre con ansiedad', familia: 'Vive sola; buena relación con su hermana.', medicos: 'Sin enfermedades. Sin medicamentos.', sustancias: 'Café 4 tazas al día',
        apariencia: 'Aliñada, cooperadora', animo: 'Ansioso, afecto congruente', pensamiento: 'Coherente, rumiaciones sobre el trabajo', orientacion: 'Orientada en las tres esferas', juicio: 'Conservado', riesgo: 'Sin ideación de daño. Riesgo bajo.',
        pruebas: 'Inventario de Ansiedad de Beck: 24 (moderada).',
        diagnosticos: [{ code: 'F41.1', text: 'Trastorno de ansiedad generalizada' }], pronostico: 'Favorable',
        plan: 'Terapia cognitivo-conductual semanal, 12 sesiones. Psicoeducación, higiene del sueño y reestructuración cognitiva.',
      },
      evolutions: [
        { objetivo: 'Psicoeducación sobre ansiedad', desarrollo: 'Se explica el modelo cognitivo. Se identifican pensamientos automáticos en el trabajo.', observaciones: 'Ánimo ansioso, participativa.', tareas: 'Registro de pensamientos diario', plan: 'Revisar registro' },
        { objetivo: 'Reestructuración cognitiva', desarrollo: 'Se revisa el registro. Cuestionamiento socrático de "si me equivoco me corren".', observaciones: 'Mejor sueño (6 horas). Afecto más amplio.', tareas: 'Respiración diafragmática 2 veces al día', plan: 'Exposición a escenarios temidos' },
      ],
    },
  ],
  physiotherapy: [
    {
      history: {
        ocupacion: 'Corredor amateur, ingeniero', estadoCivil: 'Casado(a)',
        motivo: 'Dolor en rodilla derecha al correr', diagnosticoMedico: 'Síndrome de dolor patelofemoral', antecedentes: 'Esguince de tobillo derecho hace 2 años.', actividad: 'Corre 25 km por semana',
        eva: 6, localizacion: 'Cara anterior de rodilla derecha', tipo: 'Aumenta al bajar escaleras y después de 5 km',
        signos: { ta: '120/75', fc: 62 }, postura: 'Valgo de rodilla derecha', arcos: 'Flexión de rodilla completa con dolor al final', fuerza: 'Glúteo medio derecho 4/5, cuádriceps 4/5', pruebas: 'Clarke positivo', marcha: 'Sin alteraciones',
        diagnosticoFisio: 'Dolor patelofemoral derecho por debilidad de glúteo medio y cuádriceps.', diagnosticos: [{ code: 'M22.2', text: 'Trastornos patelofemorales' }], pronostico: 'Bueno',
        objetivos: 'Disminuir dolor a EVA ≤2 y volver a correr 10 km.', plan: '10 sesiones, 2 por semana: terapia manual, fortalecimiento y readaptación a la carrera.',
      },
      evolutions: [
        { evaInicial: 6, tecnicas: 'Electroterapia TENS 15 min, liberación miofascial de tensor de la fascia lata.', ejercicios: 'Puente glúteo, almeja con banda, sentadilla isométrica.', evaFinal: 3, respuesta: 'Buena tolerancia.', casa: 'Ejercicios 3 series de 12 diario' },
        { evaInicial: 4, tecnicas: 'Terapia manual y vendaje neuromuscular.', ejercicios: 'Step down, sentadilla a una pierna asistida.', evaFinal: 2, respuesta: 'Corre 3 km sin dolor.', casa: 'Progresión de carrera 2 km + 1 km' },
      ],
    },
  ],
  nutrition: [
    {
      history: {
        ocupacion: 'Abogada', estadoCivil: 'Casado(a)',
        motivo: 'Bajar de peso y mejorar la energía', heredofamiliares: 'Padre con diabetes tipo 2', patologicos: 'Hipotiroidismo', medicamentos: 'Levotiroxina 50 mcg', alergias: 'Lactosa (intolerancia)',
        actividad: 'Caminata 2 veces por semana', agua: 1.2, horarios: 'Desayuna 10:00, come 16:00, cena 22:00. Duerme 6 horas.', recordatorio: 'Café con pan dulce; torta; tacos de guisado; refresco.',
        medidas: { peso: 78, talla: 160, cintura: 92, cadera: 108, grasa: 38 }, bioquimicos: 'Glucosa 104 mg/dL, triglicéridos 180 mg/dL.',
        diagnosticoNutricio: 'Obesidad grado I con riesgo cardiometabólico por circunferencia de cintura.', pronostico: 'Bueno con apego',
        plan: '1,500 kcal: 50 % HC, 25 % proteína, 25 % lípidos. 5 tiempos de comida.', metas: 'Bajar 4 kg en 2 meses',
      },
      evolutions: [
        { medidas: { peso: 76.2, talla: 160, cintura: 89, grasa: 36.5 }, adherencia: 'Bueno', evolucion: 'Bajó 1.8 kg. Más energía, sin refresco entre semana.', ajustes: 'Agregar colación de proteína por la tarde.' },
        { medidas: { peso: 74.9, talla: 160, cintura: 87, grasa: 35.4 }, adherencia: 'Regular', evolucion: 'Bajó 1.3 kg. Fines de semana con excesos.', ajustes: 'Opciones para comer fuera.' },
      ],
    },
  ],
};

const ADDENDA: Record<keyof typeof CASES, string> = {
  medical: 'Se corrige: la alergia referida es a sulfas, no a penicilina.',
  dental: 'Se aclara: el dolor a estímulos fríos inició hace 6 semanas, no hace 1 mes.',
  psychology: 'Se aclara: el cambio de puesto fue hace 5 meses; el insomnio inició 1 mes después.',
  physiotherapy: 'Se corrige: el esguince previo fue de tobillo izquierdo.',
  nutrition: 'Se corrige: la levotiroxina es de 75 mcg, no de 50 mcg.',
};

/**
 * Clinical records for the health demos: patient data, signed histories and progress notes linked
 * to their visits (odontograms in dental), a signed informed consent, an addendum and a draft.
 */
async function seedClinical() {
  const db = getDb();
  const owner = await db.query.users.findFirst({ where: eq(users.email, DEMO_OWNER.email) });
  if (!owner) return;
  const professional = { license: '9876543', institution: 'Universidad de Colima', specialty: null, specialtyLicense: null };
  await db.update(users).set({ professional }).where(eq(users.id, owner.id));
  const author = { name: owner.name, ...professional };
  const TEMPLATES = {
    medical: ['medical_history', 'medical_evolution'], dental: ['dental_history', 'dental_evolution'], psychology: ['psychology_history', 'psychology_session'],
    physiotherapy: ['physio_history', 'physio_session'], nutrition: ['nutrition_history', 'nutrition_followup'],
  } as const;
  const STREETS = ['Calle Madero 120, Centro', 'Av. Pino Suárez 455, Jardines', 'Calle Aldama 80, El Moralete', 'Av. Tecnológico 900, Lomas', 'Calle Obregón 33, San Pablo'];
  let total = 0;
  for (const slug of ['medico-demo', 'dental-demo', 'psicologia-demo', 'fisioterapia-demo', 'nutricion-demo']) {
    const t = await tenantBySlug(slug);
    if (!t) continue;
    const type = t.businessType as keyof typeof CASES;
    const [histTpl, evoTpl] = TEMPLATES[type];
    const titleOf = (id: string) => CLINICAL_TEMPLATES[id]!.title;
    // Patients with at least 3 completed visits, the ones a practice would have a record for
    const done = await db.execute<{ customer_id: string; ids: string[]; starts: string[] }>(sql`
      select customer_id, array_agg(id::text order by starts_at) as ids, array_agg(starts_at::text order by starts_at) as starts
      from appointments where tenant_id = ${t.id} and status = 'completed'
      group by customer_id having count(*) >= 3 order by min(starts_at) limit 6`);
    const notes: (typeof clinicalNotes.$inferInsert)[] = [];
    const sign = (customerId: string, appointmentId: string | null, template: string, content: Record<string, unknown>, at: Date, extra: Partial<typeof clinicalNotes.$inferInsert> = {}) => {
      const signedAt = new Date(at.getTime() + 50 * 60e3);
      const row = {
        id: randomUUID(), tenantId: t.id, customerId, appointmentId, template, kind: CLINICAL_TEMPLATES[template]!.kind, title: titleOf(template),
        contentEnc: encryptSecret(JSON.stringify(content)), status: 'signed' as const, authorId: owner.id, author, signedAt,
        contentHash: signatureHash({ content, template, customerId, author, signedAt }), createdAt: at, ...extra,
      };
      notes.push(row);
      return row;
    };
    for (const [i, p] of done.rows.entries()) {
      const c = CASES[type][i % CASES[type].length]!;
      const female = i % 2 === 0;
      const year = 1965 + ((i * 7) % 40);
      await db.update(customers).set({
        sex: female ? 'F' : 'M', birthday: `${year}-${String(1 + (i % 12)).padStart(2, '0')}-${String(3 + i * 4).padStart(2, '0')}`,
        address: `${STREETS[i % STREETS.length]}, Colima, Col.`,
      }).where(eq(customers.id, p.customer_id));
      const at = (k: number) => new Date(p.starts[k]!);
      const hist = sign(p.customer_id, p.ids[0]!, histTpl, c.history, at(0));
      c.evolutions.forEach((e, k) => { if (p.ids[k + 1]) sign(p.customer_id, p.ids[k + 1]!, evoTpl, e, at(k + 1)); });
      if (i === 0) {
        // A correction to the history: signed and attached, the original never changes
        const content = { texto: ADDENDA[type], sobre: `${hist.title} del ${hist.signedAt!.toISOString().slice(0, 10)}` };
        const signedAt = new Date(at(1).getTime() + 70 * 60e3);
        notes.push({
          tenantId: t.id, customerId: p.customer_id, appointmentId: p.ids[1] ?? null, template: 'addendum', kind: 'addendum', title: 'Nota aclaratoria',
          contentEnc: encryptSecret(JSON.stringify(content)), status: 'signed', authorId: owner.id, author, signedAt, amendsId: hist.id,
          contentHash: signatureHash({ content, template: 'addendum', customerId: p.customer_id, author, signedAt }), createdAt: signedAt,
        });
      }
      if (i === 1 && (type === 'medical' || type === 'dental' || type === 'physiotherapy')) {
        const patient = (await db.query.customers.findFirst({ where: eq(customers.id, p.customer_id) }))!.name;
        sign(p.customer_id, p.ids[1] ?? null, 'consent', {
          acto: type === 'dental' ? 'Tratamiento de conductos (endodoncia) del órgano dentario 36 con anestesia local.' : type === 'medical' ? 'Toma de biopsia de lesión en piel con anestesia local.' : 'Punción seca en musculatura de la pierna derecha.',
          riesgos: 'Dolor, inflamación, sangrado leve, reacción a la anestesia; poco frecuente: infección.',
          beneficios: 'Eliminar el dolor y conservar la función.',
          contingencias: true,
          firmas: {
            patient: { name: patient, image: scribble(1) }, doctor: { name: owner.name, image: scribble(2) },
            witness1: { name: 'Laura Gómez', image: scribble(3) }, witness2: { name: 'Raúl Cárdenas', image: scribble(4) },
          },
        }, at(1));
      }
    }
    // A draft (only the author sees it) for the latest visit of the first patient
    const first = done.rows[0];
    if (first) {
      const last = first.ids.length - 1;
      notes.push({
        tenantId: t.id, customerId: first.customer_id, appointmentId: first.ids[last]!, template: evoTpl, kind: 'evolution', title: titleOf(evoTpl),
        contentEnc: encryptSecret(JSON.stringify({})), status: 'draft', authorId: owner.id, author, createdAt: new Date(first.starts[last]!),
      });
    }
    if (notes.length) await db.insert(clinicalNotes).values(notes);
    total += notes.length;
  }
  console.log(`Seeded ${total} clinical documents (NOM-004 / NOM-013)`);
}
