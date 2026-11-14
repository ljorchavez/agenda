/**
 * Demo of a shop that only uses the point of sale: MIV Mantenimiento, a Sayer paint and coatings store.
 * No agenda. Sayer catalogue with stock, 20 business customers with fiscal data (fake RFCs),
 * about five months of counter sales (walk-in and invoiced customers) and a cash closing per day.
 * Owned by the demo login (demo@lugali.com) and by its own login miv@lugali.com (demo1234).
 */
import { and, eq } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import { CASH_METHODS, DEFAULT_TENANT_SETTINGS, type SaleItem } from '@agenda/shared';
import { hashPassword } from '../lib/auth.js';
import { WALK_IN_NOTE } from '../routes/pos.js';
import { getDb } from './client.js';
import { cashClosings, customers, locations, memberships, payments, productStock, products, sales, stockMoves, tenants, users } from './schema.js';

export const STORE_SLUG = 'miv-mantenimiento';
const TZ = 'America/Mexico_City';
const DAYS = 150;

// Deterministic pseudo-random: the demo looks the same on every reset
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const between = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));

type Item = { name: string; category: string; price: number; cost: number; weight: number; maxQty: number; min: number; target: number; sat: string };
const P = (name: string, category: string, price: number, weight: number, o: { maxQty?: number; min?: number; target?: number; sat?: string } = {}): Item => ({
  name,
  category,
  price: price * 100,
  cost: Math.round(price * 0.64) * 100,
  weight,
  maxQty: o.maxQty ?? 2,
  min: o.min ?? 4,
  target: o.target ?? 14,
  sat: o.sat ?? '31211500',
});

const CATALOG: Item[] = [
  // Tintas para madera
  P('Sayer Lack Tinta al alcohol Chocolate 1 L', 'Tintas para madera', 289, 6),
  P('Sayer Lack Tinta al alcohol Caoba clásico 1 L', 'Tintas para madera', 289, 7),
  P('Sayer Lack Tinta al alcohol Nogal americano 1 L', 'Tintas para madera', 289, 6),
  P('Sayer Lack Tinta al alcohol Cedro 1 L', 'Tintas para madera', 289, 4),
  P('Sayer Lack Tinta al alcohol Maple 1 L', 'Tintas para madera', 289, 3),
  P('Sayer Lack Tinta al alcohol Roble 1 L', 'Tintas para madera', 289, 3),
  P('Sayer Lack Tinta al aceite Caoba clásico 1 L', 'Tintas para madera', 315, 3),
  P('Sayer Lack Tinta al aceite Nogal 1 L', 'Tintas para madera', 315, 2),
  // Selladores, lacas y barnices
  P('Sayer Lack Sellador de nitrocelulosa 4 L', 'Selladores y lacas', 985, 4, { min: 3, target: 10 }),
  P('Sayer Lack Sellador de nitrocelulosa 1 L', 'Selladores y lacas', 289, 6),
  P('Sayer Lack Laca nitrocelulosa brillante 4 L', 'Selladores y lacas', 1180, 3, { min: 2, target: 8 }),
  P('Sayer Lack Laca nitrocelulosa semimate 1 L', 'Selladores y lacas', 335, 5),
  P('Sayer Lack Barniz Poly Lack 1 L', 'Selladores y lacas', 299, 5),
  P('Sayer Lack Barniz de poliuretano brillante 4 L', 'Selladores y lacas', 1390, 2, { min: 2, target: 6 }),
  P('Sayer Lack Barniz para pisos de parquet y duela 1 L', 'Selladores y lacas', 420, 2),
  P('Sayer Lack Barniz para exterior Nogal americano 1 L', 'Selladores y lacas', 349, 3),
  P('Sayer Lack Fondo catalizado de poliuretano 1 L', 'Selladores y lacas', 455, 3),
  P('Sayer Lack Catalizador de poliuretano 1 L', 'Selladores y lacas', 389, 3),
  // Resanadores
  P('Sayer Lack Resanador para madera Pino 250 ml', 'Resanadores', 98, 5, { maxQty: 3 }),
  P('Sayer Lack Resanador para madera Caoba 250 ml', 'Resanadores', 98, 4, { maxQty: 3 }),
  P('Sayer Lack Resanador para madera Nogal 250 ml', 'Resanadores', 98, 4, { maxQty: 3 }),
  P('Sayer Kit resanador automotriz KF-0500 1 L', 'Resanadores', 465, 2, { min: 2, target: 8 }),
  // Diluyentes
  P('Sayer Lack Diluyente para nitrocelulosa (thinner) 4 L', 'Diluyentes', 365, 9, { maxQty: 4, min: 6, target: 24, sat: '31211800' }),
  P('Sayer Lack Diluyente para nitrocelulosa (thinner) 1 L', 'Diluyentes', 115, 10, { maxQty: 3, min: 8, target: 30, sat: '31211800' }),
  P('Sayer Lack Diluyente para poliuretano 1 L', 'Diluyentes', 189, 3, { sat: '31211800' }),
  P('Sayer Lack Aguarrás 1 L', 'Diluyentes', 99, 5, { maxQty: 3, sat: '31211800' }),
  // Pintura arquitectónica
  P('Sayer Vinílica Contractor mate Blanco 19 L', 'Pintura arquitectónica', 1450, 3, { min: 3, target: 10 }),
  P('Sayer Vinílica Facilita mate Blanco 19 L', 'Pintura arquitectónica', 1190, 3, { min: 3, target: 10 }),
  P('Sayer Vinílica Magicolor mate 4 L', 'Pintura arquitectónica', 389, 5),
  P('Sayer Sellalak sellador vinílico 5 en 1 4 L', 'Pintura arquitectónica', 559, 4),
  P('Sayer Esmalte X-trong Gris perla brillante 1 L', 'Pintura arquitectónica', 298, 3),
  P('Sayer Esmalte X-trong Negro brillante 1 L', 'Pintura arquitectónica', 298, 3),
  // Especialidades
  P('Sayer Lack Antiparásitos para madera 1 L', 'Especialidades', 239, 3),
  P('Sayer Lack Aceite danés Roble 1 L', 'Especialidades', 369, 2),
  P('Sayer Lack Teka Oil exterior 1 L', 'Especialidades', 399, 2),
  P('Sayer Lack Cera para madera 1 L', 'Especialidades', 265, 2),
  P('Sayer Lack Removelack removedor 250 ml', 'Especialidades', 119, 3),
  P('Sayer Lack Repelente de agua 1 L', 'Especialidades', 285, 2),
  P('Sayer Art Resina para encapsular 1 L', 'Especialidades', 690, 2, { min: 2, target: 6 }),
  P('Sayer Lack Silack cortagrasa 500 ml', 'Especialidades', 89, 3, { maxQty: 3 }),
  P('Sayer Glue adhesivo 250 ml', 'Especialidades', 129, 3),
  // Accesorios
  P('Brocha de cerda 2"', 'Accesorios', 59, 7, { maxQty: 4, min: 8, target: 30, sat: '31211900' }),
  P('Brocha de cerda 4"', 'Accesorios', 95, 5, { maxQty: 3, min: 6, target: 24, sat: '31211900' }),
  P('Rodillo felpa 9"', 'Accesorios', 129, 4, { maxQty: 2, min: 5, target: 18, sat: '31211900' }),
  P('Charola para rodillo', 'Accesorios', 79, 3, { sat: '31211900' }),
  P('Lija de agua grano 220', 'Accesorios', 14, 8, { maxQty: 10, min: 30, target: 120, sat: '31191500' }),
  P('Lija para madera grano 120', 'Accesorios', 12, 7, { maxQty: 10, min: 30, target: 120, sat: '31191500' }),
  P('Cinta masking 1" (24 mm)', 'Accesorios', 42, 6, { maxQty: 4, min: 10, target: 40, sat: '31201500' }),
  P('Estopa blanca 1 kg', 'Accesorios', 68, 4, { maxQty: 2, min: 5, target: 20, sat: '47131500' }),
];
// These run low near the end so the demo shows the low-stock alert
const RUNS_LOW = ['Sayer Lack Tinta al alcohol Caoba clásico 1 L', 'Sayer Lack Diluyente para nitrocelulosa (thinner) 1 L', 'Lija de agua grano 220'];

/** EAN-13 style code starting with 750 (Mexico), with its check digit. Fake: only for the demo. */
function barcode(i: number) {
  const body = `750${String(4419000 + i * 37).padStart(9, '0')}`.slice(0, 12);
  const sum = [...body].reduce((a, d, k) => a + Number(d) * (k % 2 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}

/** Business customers that ask for an invoice. RFCs are invented (valid format, not real people or companies). */
const FISCAL_CUSTOMERS: { name: string; rfc: string; regime: string; use: string; zip: string }[] = [
  { name: 'Constructora Volcán de Colima SA de CV', rfc: 'CVC120314QK8', regime: '601', use: 'G03', zip: '28017' },
  { name: 'Muebles Finos del Valle SA de CV', rfc: 'MFV150722HN3', regime: '601', use: 'G01', zip: '28984' },
  { name: 'Carpintería y Diseño Álvarez SA de CV', rfc: 'CDA180905T21', regime: '601', use: 'G01', zip: '28970' },
  { name: 'Acabados Profesionales del Pacífico SA de CV', rfc: 'APP110130LM5', regime: '601', use: 'G03', zip: '28040' },
  { name: 'Inmobiliaria Las Palmas Colima SA de CV', rfc: 'IPC090611RB7', regime: '601', use: 'G03', zip: '28010' },
  { name: 'Hotel Real de Comala SA de CV', rfc: 'HRC140218ZX4', regime: '601', use: 'G03', zip: '28450' },
  { name: 'Colegio Los Andes AC', rfc: 'CAN030826MS6', regime: '603', use: 'G03', zip: '28030' },
  { name: 'Raúl Hernández Pizano', rfc: 'HEPR780412JT5', regime: '612', use: 'G03', zip: '28979' },
  { name: 'Arturo Ochoa Ceballos', rfc: 'OOCA820915G42', regime: '626', use: 'G03', zip: '28060' },
  { name: 'Juan Pablo Cárdenas Llamas', rfc: 'CALJ750301AB9', regime: '612', use: 'G01', zip: '28970' },
  { name: 'Javier Mendoza Virgen', rfc: 'MEVJ880704PL1', regime: '626', use: 'G03', zip: '28978' },
  { name: 'Martín Gaitán Larios', rfc: 'GALM900127UZ3', regime: '626', use: 'G03', zip: '28017' },
  { name: 'Laura Pizano Quintero', rfc: 'PIQL850619KD2', regime: '612', use: 'G03', zip: '28000' },
  { name: 'Diseño de Interiores Nava SA de CV', rfc: 'DIN170403EE1', regime: '601', use: 'G03', zip: '28017' },
  { name: 'Restaurante El Charco de la Higuera SA de CV', rfc: 'RCH100815VV9', regime: '601', use: 'G03', zip: '28000' },
  { name: 'Desarrollos Tecomán SA de CV', rfc: 'DTE130927FG6', regime: '601', use: 'G03', zip: '28100' },
  { name: 'Ignacio Ramos Torres', rfc: 'RATI710923SQ7', regime: '612', use: 'G01', zip: '28030' },
  { name: 'Mantenimiento Industrial Manzanillo SA de CV', rfc: 'MIM160512AA4', regime: '601', use: 'G03', zip: '28219' },
  { name: 'Fernanda Solís Barajas', rfc: 'SOBF920210HU8', regime: '626', use: 'G01', zip: '28970' },
  { name: 'Ricardo Zamora Delgado', rfc: 'ZADR800503CQ1', regime: '612', use: 'G03', zip: '28050' },
];

const emailFor = (name: string, i: number) =>
  `${name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ (sa de cv|ac)$/, '').replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '').slice(0, 28)}${i}@example.com`;

async function insertChunked<T extends Record<string, unknown>>(table: Parameters<ReturnType<typeof getDb>['insert']>[0], rows: T[], size = 400) {
  const db = getDb();
  for (let i = 0; i < rows.length; i += size) await db.insert(table).values(rows.slice(i, i + size) as never);
}

type Method = 'cash' | 'debit_card' | 'credit_card' | 'transfer';
function methodFor(total: number, invoiced: boolean): Method {
  const r = rand();
  if (invoiced) return r < 0.55 ? 'transfer' : r < 0.8 ? 'debit_card' : r < 0.92 ? 'credit_card' : 'cash';
  if (total > 200000) return r < 0.3 ? 'cash' : r < 0.6 ? 'debit_card' : r < 0.85 ? 'credit_card' : 'transfer';
  return r < 0.62 ? 'cash' : r < 0.82 ? 'debit_card' : r < 0.92 ? 'credit_card' : 'transfer';
}

/** Deletes and recreates the store demo. */
export async function seedStore() {
  seed = 7;
  const db = getDb();
  const old = await db.query.tenants.findFirst({ where: eq(tenants.slug, STORE_SLUG) });
  if (old) await db.delete(tenants).where(eq(tenants.id, old.id));

  const [tenant] = await db
    .insert(tenants)
    .values({
      name: 'MIV Mantenimiento',
      slug: STORE_SLUG,
      businessType: 'other',
      phone: '+523123100100',
      timezone: TZ,
      description: 'Pinturas y recubrimientos Sayer: madera, arquitectónica y automotriz. Cuenta de demostración.',
      city: 'Villa de Álvarez',
      state: 'Colima',
      directoryListed: false,
      plan: 'premium',
      settings: {
        ...DEFAULT_TENANT_SETTINGS,
        onlineBookingEnabled: false,
        remindersEnabled: false,
        bookings: { enabled: false },
        hours: { days: [1, 2, 3, 4, 5, 6], open: '08:30', close: '19:00', slotMinutes: 30 },
        pos: { stockPolicy: 'warn', categories: [...new Set(CATALOG.map((p) => p.category))] },
      },
    })
    .returning();
  const tenantId = tenant!.id;
  const [loc] = await db.select().from(locations).where(and(eq(locations.tenantId, tenantId), eq(locations.isPrimary, true))).limit(1);
  if (!loc) throw new Error('store demo: no primary location');
  await db.update(locations).set({ name: 'Mostrador' }).where(eq(locations.id, loc.id));

  // Logins: the shared demo owner, plus the store's own owner and its cashier
  const pw = await hashPassword('demo1234');
  const demoOwner = await db.query.users.findFirst({ where: eq(users.email, 'demo@lugali.com') });
  if (demoOwner) await db.insert(memberships).values({ tenantId, userId: demoOwner.id, role: 'owner' }).onConflictDoNothing();
  const people: { email: string; name: string; role: 'owner' | 'staff' }[] = [
    { email: 'miv@lugali.com', name: 'Administración MIV', role: 'owner' },
    { email: 'caja.miv@lugali.com', name: 'Caja MIV', role: 'staff' },
  ];
  const team: { id: string; name: string }[] = [];
  for (const u of people) {
    await db.delete(users).where(eq(users.email, u.email));
    const [row] = await db.insert(users).values({ email: u.email, name: u.name, passwordHash: pw }).returning();
    await db.insert(memberships).values({ tenantId, userId: row!.id, role: u.role });
    team.push({ id: row!.id, name: row!.name });
  }
  const [admin, cashier] = team as [{ id: string; name: string }, { id: string; name: string }];

  // Catalogue
  const prods = await db
    .insert(products)
    .values(
      CATALOG.map((p, i) => ({
        tenantId, name: p.name, sku: barcode(i), category: p.category, priceCents: p.price, costCents: p.cost,
        minStock: p.min, iva: '16' as const, satKey: p.sat, trackStock: true,
      })),
    )
    .returning();
  const info = new Map(prods.map((p, i) => [p.id, CATALOG[i]!]));
  const totalWeight = CATALOG.reduce((a, p) => a + p.weight, 0);
  const weighted = () => {
    let r = rand() * totalWeight;
    for (let i = 0; i < CATALOG.length; i++) if ((r -= CATALOG[i]!.weight) <= 0) return prods[i]!;
    return prods[prods.length - 1]!;
  };

  // Customers: 20 with fiscal data, created over the first months
  const now = DateTime.now().setZone(TZ);
  const start = now.minus({ days: DAYS }).startOf('day');
  const custs = await db
    .insert(customers)
    .values(
      FISCAL_CUSTOMERS.map((c, i) => ({
        tenantId,
        name: c.name,
        phone: `+52312${String(3300000 + i * 4111).slice(-7)}`,
        email: emailFor(c.name, i + 1),
        fiscal: { rfc: c.rfc, legalName: c.name.toUpperCase(), taxSystem: c.regime, zip: c.zip, use: c.use, email: emailFor(c.name, i + 1) },
        createdAt: start.plus({ days: Math.floor(i * 4.5) }).toJSDate(),
      })),
    )
    .returning();
  const [walkIn] = await db.insert(customers).values({ tenantId, name: 'Venta de mostrador', notes: WALK_IN_NOTE, archivedAt: new Date() }).returning();

  // Day by day: morning delivery when something is low, then the day's tickets, then the cash closing
  const qty = new Map<string, number>(prods.map((p) => [p.id, info.get(p.id)!.target]));
  const saleRows: (typeof sales.$inferInsert)[] = [];
  const payRows: (typeof payments.$inferInsert)[] = [];
  const moveRows: (typeof stockMoves.$inferInsert)[] = [];
  const closingRows: (typeof cashClosings.$inferInsert)[] = [];
  const move = (productId: string, change: number, reason: 'in' | 'sale' | 'return' | 'adjust', at: Date, extra: { saleId?: string; note?: string; by?: { id: string; name: string } } = {}) => {
    const after = (qty.get(productId) ?? 0) + change;
    qty.set(productId, after);
    moveRows.push({
      tenantId, productId, locationId: loc.id, qtyChange: change, qtyAfter: after, reason, saleId: extra.saleId ?? null,
      note: extra.note ?? null, createdBy: (extra.by ?? admin).id, createdByName: (extra.by ?? admin).name, createdAt: at,
    });
  };
  const opening = start.minus({ days: 1 }).set({ hour: 9 }).toJSDate();
  for (const p of prods) {
    const target = info.get(p.id)!.target;
    moveRows.push({ tenantId, productId: p.id, locationId: loc.id, qtyChange: target, qtyAfter: target, reason: 'in', note: 'Existencia inicial', createdBy: admin.id, createdByName: admin.name, createdAt: opening });
  }

  let number = 0;
  for (let d = 0; d <= DAYS; d++) {
    const day = start.plus({ days: d });
    if (day.weekday === 7) continue; // closed on Sundays
    const isToday = day.hasSame(now, 'day');
    const saturday = day.weekday === 6;
    const opens = day.set({ hour: saturday ? 9 : 8, minute: 30 });
    const closes = day.set({ hour: saturday ? 15 : 19, minute: 0 });
    const lateRun = d > DAYS - 14;

    // Supplier delivery on Mondays and Thursdays (or when something is out)
    for (const p of prods) {
      const it = info.get(p.id)!;
      const q = qty.get(p.id)!;
      const deliveryDay = day.weekday === 1 || day.weekday === 4;
      if (lateRun && RUNS_LOW.includes(it.name)) continue;
      if ((deliveryDay && q <= it.min) || q <= 0) {
        move(p.id, it.target - q, 'in', opens.minus({ minutes: 20 }).toJSDate(), { note: 'Pedido Sayer' });
      }
    }

    // A count that came out short (shrinkage) every so often in the last month
    if (d > DAYS - 30 && d % 7 === 3) {
      const p = pick(prods);
      if (qty.get(p.id)! > 3) move(p.id, -between(1, 2), 'adjust', opens.plus({ minutes: 5 }).toJSDate(), { note: 'Conteo físico: faltante' });
    }

    // Tickets: busier on Saturdays and in the first days of the month, growing a little over time
    const base = saturday ? 24 : day.weekday === 1 ? 14 : 17;
    const count = Math.round((base + (day.day <= 5 ? 4 : 0) + d / 30) * (0.8 + rand() * 0.4));
    const minutes = closes.diff(opens, 'minutes').minutes;
    const times = Array.from({ length: count }, () => opens.plus({ minutes: Math.floor(rand() * minutes) })).sort((a, b) => a.toMillis() - b.toMillis());
    const dayPays: { method: Method; amount: number }[] = [];
    let daySales = 0;
    for (const at of times) {
      if (isToday && at > now) break;
      // About a third of the tickets are for a business customer (invoice); the rest are walk-in
      const known = custs.filter((c) => c.createdAt.getTime() <= at.toMillis());
      const customer = known.length && rand() < 0.32 ? known[Math.floor(Math.pow(rand(), 1.6) * known.length)]! : null;
      const lines = new Map<string, number>();
      const n = customer ? between(2, 6) : between(1, 3);
      for (let k = 0; k < n; k++) {
        const p = weighted();
        const it = info.get(p.id)!;
        const want = Math.max(1, Math.round(between(1, it.maxQty) * (customer ? 1.5 : 1)));
        lines.set(p.id, (lines.get(p.id) ?? 0) + want);
      }
      const items: SaleItem[] = [];
      for (const [pid, want] of lines) {
        const have = qty.get(pid)!;
        const q = Math.min(want, have);
        if (q <= 0) continue;
        const it = info.get(pid)!;
        // Now and then the counter gives a discount (the alerts show who and how much)
        const unit = lateRun && rand() < 0.04 ? Math.round((it.price * 0.8) / 100) * 100 : it.price;
        items.push({ productId: pid, name: it.name, qty: q, unitCents: unit, totalCents: unit * q, iva: '16', satKey: it.sat });
      }
      if (!items.length) continue;
      const total = items.reduce((a, i) => a + i.totalCents, 0);
      const by = rand() < 0.75 ? cashier : admin;
      const canceled = rand() < 0.01;
      const saleId = randomUUID();
      const when = at.toJSDate();
      number += 1;
      saleRows.push({
        id: saleId, tenantId, locationId: loc.id, number, customerId: customer?.id ?? null, items, totalCents: total,
        status: canceled ? 'canceled' : 'paid', createdBy: by.id, createdByName: by.name, createdAt: when,
        canceledAt: canceled ? at.plus({ minutes: 6 }).toJSDate() : null, canceledBy: canceled ? admin.id : null,
        offline: rand() < 0.02,
      });
      for (const i of items) move(i.productId!, -i.qty, 'sale', when, { saleId, by });
      if (canceled) for (const i of items) move(i.productId!, i.qty, 'return', at.plus({ minutes: 6 }).toJSDate(), { saleId, note: `Cancelación de venta #${number}` });
      // Some big tickets are split between cash and card
      const method = methodFor(total, Boolean(customer));
      const split = !customer && total > 150000 && rand() < 0.15 ? [{ method: 'cash' as Method, amount: Math.round(total / 200) * 100 }, { method: 'debit_card' as Method, amount: total - Math.round(total / 200) * 100 }] : [{ method, amount: total }];
      for (const s of split) {
        payRows.push({
          tenantId, customerId: customer?.id ?? walkIn!.id, amountCents: s.amount, method: s.method, status: canceled ? 'refunded' : 'paid',
          paidAt: when, locationId: loc.id, saleId, notes: `Venta #${number}`,
        });
        if (!canceled) dayPays.push(s);
      }
      if (!canceled) daySales += total;
    }

    // Cash closing at the end of every past day
    if (!isToday && daySales > 0) {
      const byMethod: Record<string, number> = Object.fromEntries(CASH_METHODS.map((m) => [m, 0]));
      for (const p of dayPays) byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amount;
      const expected = byMethod.cash ?? 0;
      const r = rand();
      const diff = r < 0.08 ? -pick([2000, 5000, 10000]) : r < 0.12 ? pick([1000, 2000]) : 0;
      closingRows.push({
        tenantId, locationId: loc.id, day: day.toISODate()!, byMethod, salesCents: daySales, expectedCashCents: expected,
        countedCashCents: Math.max(0, expected + diff),
        notes: diff < 0 ? pick(['Faltó cambio', 'Se pagó al repartidor del garrafón', 'Diferencia por redondeo de cambio']) : diff > 0 ? 'Sobrante: cliente no esperó su cambio' : null,
        closedBy: admin.id, closedByName: admin.name, createdAt: closes.plus({ minutes: 15 }).toJSDate(),
      });
    }
  }

  await insertChunked(sales, saleRows);
  await insertChunked(payments, payRows);
  await insertChunked(stockMoves, moveRows);
  await insertChunked(cashClosings, closingRows);
  await db.insert(productStock).values(prods.map((p) => ({ productId: p.id, locationId: loc.id, tenantId, qty: qty.get(p.id)! })));
  console.log(`Seeded store "${tenant!.name}": ${prods.length} products, ${custs.length} customers, ${saleRows.length} sales, ${closingRows.length} cash closings`);
}
