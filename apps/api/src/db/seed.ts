/**
 * Demo data: `pnpm db:seed`
 * Creates a nutrition clinic with services, customers and ~5 months of appointments/payments.
 * Login: demo@agenda.mx / demo1234
 */
import { eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { DEFAULT_PAYMENT_SETTINGS, DEFAULT_TENANT_SETTINGS } from '@agenda/shared';
import { hashPassword } from '../lib/auth.js';
import { closeDb, getDb } from './client.js';
import { appointments, customers, payments, services, tenants, users } from './schema.js';

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

  await db.insert(users).values({
    tenantId,
    email: 'demo@agenda.mx',
    name: 'Dra. Ana López',
    role: 'owner',
    passwordHash: await hashPassword('demo1234'),
  });

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
  ];
  const custs = await db
    .insert(customers)
    .values(
      names.map((name, i) => ({
        tenantId,
        name,
        phone: `+52551000${String(1000 + i).slice(-4)}`,
        email: `${name.split(' ')[0]!.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}${i}@example.com`,
        createdAt: DateTime.now().minus({ days: 150 - i * 6 }).toJSDate(),
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
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => closeDb());
