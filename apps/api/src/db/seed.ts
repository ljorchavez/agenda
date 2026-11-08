/**
 * Demo data: `pnpm db:seed`
 * Creates a nutrition clinic with services, customers and ~14 months of appointments/payments and two team members.
 * Also a restaurant (restaurante@agenda.mx / demo1234) and a set of clearly-labelled demo
 * businesses (slug `demo-*`) so the public directory map has content.
 * Login: demo@agenda.mx / demo1234
 */
import { eq, like } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DEFAULT_PAYMENT_SETTINGS, DEFAULT_TENANT_SETTINGS } from '@agenda/shared';
import { hashPassword } from '../lib/auth.js';
import { closeDb, getDb } from './client.js';
import { appointments, customers, diningTables, payments, services, tenants, users } from './schema.js';

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
