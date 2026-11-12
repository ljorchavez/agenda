import { Hono } from 'hono';
import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  productInputSchema,
  saleCreateSchema,
  saleTotal,
  stockAdjustSchema,
  type ProductDto,
  type SaleDto,
  type SaleTicketDto,
  type SaleItem,
  type StockMoveDto,
  type StockReason,
} from '@agenda/shared';
import { getDb, type Db } from '../db/client.js';
import { customers, invoices, locations, payments, productStock, products, sales, stockMoves, tenants, users, type Product, type Sale } from '../db/schema.js';
import { getScope } from '../lib/access.js';
import { AppError, notFound } from '../lib/errors.js';
import { guardRow, locationForWrite } from '../lib/locations.js';
import { assertFeature } from '../lib/plan.js';
import { requireBusinessManager, requireManager, type AppEnv } from '../middleware/auth.js';

/**
 * Light point of sale: products with stock per location, counter sales with several lines and
 * split payments (they go into the cash closing like any payment), cancellations that put the
 * stock back, and each product's stock history.
 */
export const posRoutes = new Hono<AppEnv>();

type Tx = Pick<Db, 'execute' | 'insert' | 'select' | 'update' | 'query'>;

/** Payments need a customer; counter sales without one go to this hidden customer. */
export const WALK_IN_NOTE = '__venta_mostrador__';
async function walkInCustomer(tx: Tx, tenantId: string): Promise<string> {
  const found = await tx.query.customers.findFirst({
    where: and(eq(customers.tenantId, tenantId), eq(customers.notes, WALK_IN_NOTE)),
    columns: { id: true },
  });
  if (found) return found.id;
  const [row] = await tx
    .insert(customers)
    .values({ tenantId, name: 'Venta de mostrador', notes: WALK_IN_NOTE, archivedAt: new Date() })
    .returning({ id: customers.id });
  return row!.id;
}

const userName = async (db: Pick<Db, 'query'>, id: string) =>
  (await db.query.users.findFirst({ where: eq(users.id, id), columns: { name: true } }))?.name ?? null;

/** Adds `change` units at a location (negative = takes them) and records the move. Returns the new count. */
async function moveStock(
  tx: Tx,
  m: { tenantId: string; productId: string; locationId: string; change: number; reason: StockReason; saleId?: string | null; note?: string | null; userId: string; userName: string | null },
): Promise<number> {
  const res = await tx.execute<{ qty: number }>(sql`
    insert into product_stock (product_id, location_id, tenant_id, qty, updated_at)
    values (${m.productId}, ${m.locationId}, ${m.tenantId}, ${m.change}, now())
    on conflict (product_id, location_id) do update set qty = product_stock.qty + ${m.change}, updated_at = now()
    returning qty`);
  const qty = Number(res.rows[0]!.qty);
  await tx.insert(stockMoves).values({
    tenantId: m.tenantId, productId: m.productId, locationId: m.locationId, qtyChange: m.change, qtyAfter: qty,
    reason: m.reason, saleId: m.saleId ?? null, note: m.note ?? null, createdBy: m.userId, createdByName: m.userName,
  });
  return qty;
}

async function stockMap(db: Pick<Db, 'select'>, tenantId: string, productIds: string[]) {
  const map = new Map<string, Record<string, number>>();
  if (!productIds.length) return map;
  const rows = await db
    .select({ productId: productStock.productId, locationId: productStock.locationId, qty: productStock.qty })
    .from(productStock)
    .where(and(eq(productStock.tenantId, tenantId), inArray(productStock.productId, productIds)));
  for (const r of rows) map.set(r.productId, { ...(map.get(r.productId) ?? {}), [r.locationId]: r.qty });
  return map;
}

const toProductDto = (p: Product, byLoc: Record<string, number>, locationId: string | null): ProductDto => {
  const stock = locationId ? byLoc[locationId] ?? 0 : Object.values(byLoc).reduce((a, b) => a + b, 0);
  return {
    id: p.id,
    name: p.name,
    sku: p.sku,
    category: p.category,
    priceCents: p.priceCents,
    costCents: p.costCents,
    trackStock: p.trackStock,
    minStock: p.minStock,
    iva: p.iva,
    satKey: p.satKey,
    requiresPrescription: p.requiresPrescription,
    active: p.active,
    stock,
    stockByLocation: byLoc,
    low: p.trackStock && p.minStock != null && stock <= p.minStock,
  };
};

const findProduct = async (db: Pick<Db, 'query'>, tenantId: string, id: string) => {
  const p = await db.query.products.findFirst({ where: and(eq(products.id, id), eq(products.tenantId, tenantId)) });
  if (!p) throw notFound('product');
  return p;
};

/** A gerente sees their location; owners the one asked for (or the total when none). */
const viewLocation = (c: { get: (k: 'role' | 'locationId') => string | null | undefined }, requested?: string) =>
  (c.get('role') === 'owner' ? null : c.get('locationId')) || requested || null;

// ---------- Products ----------

posRoutes.get('/products', async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const all = c.req.query('all') === '1';
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.tenantId, tenantId), all ? undefined : eq(products.active, true)))
    .orderBy(asc(products.category), asc(products.name));
  const stock = await stockMap(db, tenantId, rows.map((p) => p.id));
  const loc = viewLocation(c as never, c.req.query('locationId'));
  return c.json(rows.map((p) => toProductDto(p, stock.get(p.id) ?? {}, loc)));
});

const productValues = (i: ReturnType<typeof productInputSchema.parse>) => ({
  name: i.name,
  sku: i.sku,
  category: i.category,
  priceCents: i.priceCents,
  costCents: i.costCents,
  trackStock: i.trackStock,
  minStock: i.minStock,
  iva: i.iva,
  satKey: i.satKey,
  requiresPrescription: i.requiresPrescription,
  active: i.active,
});

posRoutes.post('/products', requireBusinessManager, async (c) => {
  const input = productInputSchema.parse(await c.req.json());
  const db = getDb();
  const tenantId = c.get('tenantId');
  await assertFeature(db, tenantId, 'cash');
  const uid = c.get('userId');
  const name = await userName(db, uid);
  const locationId = input.initialStock ? (await locationForWrite(db, c, input.locationId, { create: true }))! : null;
  const p = await db.transaction(async (tx) => {
    const [row] = await tx.insert(products).values({ tenantId, ...productValues(input) }).returning();
    if (locationId && input.initialStock) {
      await moveStock(tx as unknown as Tx, { tenantId, productId: row!.id, locationId, change: input.initialStock, reason: 'in', note: 'Existencia inicial', userId: uid, userName: name });
    }
    return row!;
  });
  const stock = await stockMap(db, tenantId, [p.id]);
  return c.json(toProductDto(p, stock.get(p.id) ?? {}, locationId), 201);
});

posRoutes.put('/products/:id', requireBusinessManager, async (c) => {
  const input = productInputSchema.parse(await c.req.json());
  const db = getDb();
  const tenantId = c.get('tenantId');
  const [row] = await db
    .update(products)
    .set({ ...productValues(input), updatedAt: new Date() })
    .where(and(eq(products.id, c.req.param('id')), eq(products.tenantId, tenantId)))
    .returning();
  if (!row) throw notFound('product');
  const stock = await stockMap(db, tenantId, [row.id]);
  return c.json(toProductDto(row, stock.get(row.id) ?? {}, null));
});

/** Sold products stay in the history; the catalog item is just hidden. */
posRoutes.delete('/products/:id', requireBusinessManager, async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const p = await findProduct(db, tenantId, c.req.param('id'));
  const sold = await db.query.stockMoves.findFirst({ where: and(eq(stockMoves.productId, p.id), eq(stockMoves.reason, 'sale')) });
  if (sold) await db.update(products).set({ active: false, updatedAt: new Date() }).where(eq(products.id, p.id));
  else await db.delete(products).where(eq(products.id, p.id));
  return sold ? c.json({ deactivated: true }) : c.body(null, 204);
});

/** Stock that arrived (`in`) or a physical count (`set`) at a location. */
posRoutes.post('/products/:id/stock', requireManager, async (c) => {
  const input = stockAdjustSchema.parse(await c.req.json());
  const db = getDb();
  const tenantId = c.get('tenantId');
  await assertFeature(db, tenantId, 'cash');
  const p = await findProduct(db, tenantId, c.req.param('id'));
  const locationId = (await locationForWrite(db, c, input.locationId, { create: true }))!;
  const uid = c.get('userId');
  const name = await userName(db, uid);
  const qty = await db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from product_stock where product_id = ${p.id} and location_id = ${locationId} for update`);
    const cur = (await tx.query.productStock.findFirst({ where: and(eq(productStock.productId, p.id), eq(productStock.locationId, locationId)) }))?.qty ?? 0;
    const change = input.mode === 'in' ? input.qty : input.qty - cur;
    if (change === 0) return cur;
    return moveStock(tx as unknown as Tx, { tenantId, productId: p.id, locationId, change, reason: input.mode === 'in' ? 'in' : 'adjust', note: input.note, userId: uid, userName: name });
  });
  return c.json({ qty });
});

posRoutes.get('/products/:id/moves', async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const p = await findProduct(db, tenantId, c.req.param('id'));
  const loc = viewLocation(c as never, c.req.query('locationId'));
  const rows = await db
    .select({ m: stockMoves, saleNumber: sales.number })
    .from(stockMoves)
    .leftJoin(sales, eq(sales.id, stockMoves.saleId))
    .where(and(eq(stockMoves.productId, p.id), loc ? eq(stockMoves.locationId, loc) : undefined))
    .orderBy(desc(stockMoves.createdAt))
    .limit(100);
  const out: StockMoveDto[] = rows.map(({ m, saleNumber }) => ({
    id: m.id,
    locationId: m.locationId,
    qtyChange: m.qtyChange,
    qtyAfter: m.qtyAfter,
    reason: m.reason,
    saleNumber: saleNumber ?? null,
    note: m.note,
    createdByName: m.createdByName,
    createdAt: m.createdAt.toISOString(),
  }));
  return c.json(out);
});

// ---------- Sales ----------

async function saleDtos(db: Db, tenantId: string, rows: (Sale & { locationName: string | null; customerName: string | null })[]): Promise<SaleDto[]> {
  const ids = rows.map((s) => s.id);
  const pays = ids.length
    ? await db
        .select({ id: payments.id, saleId: payments.saleId, customerId: payments.customerId, method: payments.method, amountCents: payments.amountCents, inv: invoices })
        .from(payments)
        .leftJoin(invoices, and(eq(invoices.paymentId, payments.id), ne(invoices.status, 'canceled')))
        .where(and(eq(payments.tenantId, tenantId), inArray(payments.saleId, ids)))
        .orderBy(asc(payments.createdAt))
    : [];
  return rows.map((s) => {
    const mine = pays.filter((p) => p.saleId === s.id);
    const inv = mine.find((p) => p.inv)?.inv ?? null;
    return {
      id: s.id,
      number: s.number,
      locationId: s.locationId,
      locationName: s.locationName,
      customerId: s.customerId,
      customerName: s.customerName,
      payerCustomerId: mine[0]?.customerId ?? null,
      items: s.items,
      totalCents: s.totalCents,
      payments: mine.map((p) => ({ id: p.id, method: p.method, amountCents: p.amountCents })),
      status: s.status,
      notes: s.notes,
      createdByName: s.createdByName,
      createdAt: s.createdAt.toISOString(),
      invoice: inv ? { id: inv.id, series: inv.series, folio: inv.folio, test: inv.test } : null,
    };
  });
}

const saleSelect = (db: Db) =>
  db
    .select({ s: sales, locationName: locations.name, customerName: customers.name })
    .from(sales)
    .leftJoin(locations, eq(locations.id, sales.locationId))
    .leftJoin(customers, eq(customers.id, sales.customerId));

posRoutes.get('/sales', async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const scope = await getScope(db, c);
  const from = c.req.query('from');
  const to = c.req.query('to');
  const loc = viewLocation(c as never, c.req.query('locationId'));
  const rows = await saleSelect(db)
    .where(
      and(
        eq(sales.tenantId, tenantId),
        from ? gte(sales.createdAt, new Date(from)) : undefined,
        to ? lt(sales.createdAt, new Date(to)) : undefined,
        loc ? eq(sales.locationId, loc) : undefined,
        // Team members with their own agenda see only what they sold
        scope.personal ? eq(sales.createdBy, scope.userId) : undefined,
      ),
    )
    .orderBy(desc(sales.createdAt))
    .limit(1000);
  return c.json(await saleDtos(db, tenantId, rows.map((r) => ({ ...r.s, locationName: r.locationName, customerName: r.customerName }))));
});

posRoutes.post('/sales', async (c) => {
  const input = saleCreateSchema.parse(await c.req.json());
  const db = getDb();
  const tenantId = c.get('tenantId');
  await assertFeature(db, tenantId, 'cash');
  const locationId = (await locationForWrite(db, c, input.locationId, { create: true }))!;
  const customer = input.customerId
    ? await db.query.customers.findFirst({ where: and(eq(customers.id, input.customerId), eq(customers.tenantId, tenantId)) })
    : null;
  if (input.customerId && !customer) throw notFound('customer');

  const productIds = [...new Set(input.items.map((i) => i.productId).filter((x): x is string => Boolean(x)))];
  const prods = productIds.length ? await db.select().from(products).where(and(eq(products.tenantId, tenantId), inArray(products.id, productIds))) : [];
  const byId = new Map(prods.map((p) => [p.id, p]));
  const items: SaleItem[] = input.items.map((i) => {
    if (i.productId) {
      const p = byId.get(i.productId);
      if (!p || !p.active) throw notFound('product');
      const unit = i.unitCents ?? p.priceCents;
      return { productId: p.id, name: p.name, qty: i.qty, unitCents: unit, totalCents: unit * i.qty, iva: p.iva, satKey: p.satKey };
    }
    return { productId: null, name: i.name!, qty: i.qty, unitCents: i.unitCents!, totalCents: i.unitCents! * i.qty, iva: '16', satKey: null };
  });
  const total = saleTotal(items);
  const paid = input.payments.reduce((a, p) => a + p.amountCents, 0);
  if (paid !== total) throw new AppError(422, 'payments_mismatch', 'Payments must add up to the total', { totalCents: total, paidCents: paid });

  const uid = c.get('userId');
  const name = await userName(db, uid);
  const sale = await db.transaction(async (tx) => {
    const t = tx as unknown as Tx;
    // One number per business, in order
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'sales:' + tenantId}))`);
    const next = await tx.execute<{ n: number }>(sql`select coalesce(max(number), 0) + 1 as n from sales where tenant_id = ${tenantId}`);
    const [s] = await tx
      .insert(sales)
      .values({ tenantId, locationId, number: Number(next.rows[0]!.n), customerId: customer?.id ?? null, items, totalCents: total, notes: input.notes, createdBy: uid, createdByName: name })
      .returning();
    for (const it of items) {
      const p = it.productId ? byId.get(it.productId) : null;
      if (!p?.trackStock) continue;
      const left = await moveStock(t, { tenantId, productId: p.id, locationId, change: -it.qty, reason: 'sale', saleId: s!.id, userId: uid, userName: name });
      if (left < 0) throw new AppError(409, 'insufficient_stock', `Not enough ${p.name}`, { productId: p.id, name: p.name, available: left + it.qty });
    }
    const payer = customer?.id ?? (await walkInCustomer(t, tenantId));
    for (const p of input.payments.filter((x) => x.amountCents > 0)) {
      await tx.insert(payments).values({
        tenantId, customerId: payer, amountCents: p.amountCents, method: p.method, status: 'paid', paidAt: new Date(),
        locationId, saleId: s!.id, notes: `Venta #${s!.number}`,
      });
    }
    return s!;
  });
  const loc = await db.query.locations.findFirst({ where: eq(locations.id, locationId), columns: { name: true } });
  const [dto] = await saleDtos(db, tenantId, [{ ...sale, locationName: loc?.name ?? null, customerName: customer?.name ?? null }]);
  return c.json(dto, 201);
});

/** Data for the printed ticket of a sale. */
posRoutes.get('/sales/:id/ticket', async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const scope = await getScope(db, c);
  const [row] = await saleSelect(db).where(and(eq(sales.id, c.req.param('id')), eq(sales.tenantId, tenantId))).limit(1);
  if (!row) throw notFound('sale');
  if (scope.personal && row.s.createdBy !== scope.userId) throw notFound('sale');
  const t = (await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) }))!;
  const loc = await db.query.locations.findFirst({ where: eq(locations.id, row.s.locationId) });
  const active = await db.select({ id: locations.id }).from(locations).where(and(eq(locations.tenantId, tenantId), eq(locations.active, true)));
  // The location's own address, else the business profile's
  const src = loc && (loc.address || !loc.isPrimary) ? loc : t;
  const address = [src.address, src.neighborhood, src.city, src.state].filter(Boolean).join(', ') || null;
  const inv = t.settings.invoicing;
  const [sale] = await saleDtos(db, tenantId, [{ ...row.s, locationName: row.locationName, customerName: row.customerName }]);
  const out: SaleTicketDto = {
    business: { name: t.name, legalName: inv?.legalName || null, rfc: inv?.rfc || null, address, phone: loc?.phone ?? t.phone },
    locationName: loc?.name ?? null,
    multiLocation: active.length > 1,
    timezone: t.timezone,
    invoicing: Boolean(t.invoicingEnc),
    sale: sale!,
  };
  return c.json(out);
});

/** Cancels a sale: its payments become refunded and the products go back to stock. */
posRoutes.post('/sales/:id/cancel', requireManager, async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const s = await db.query.sales.findFirst({ where: and(eq(sales.id, c.req.param('id')), eq(sales.tenantId, tenantId)) });
  if (!s) throw notFound('sale');
  guardRow(c, s.locationId);
  if (s.status === 'canceled') throw new AppError(409, 'already_canceled', 'This sale was already canceled');
  const invoiced = await db
    .select({ id: invoices.id })
    .from(invoices)
    .innerJoin(payments, eq(payments.id, invoices.paymentId))
    .where(and(eq(payments.saleId, s.id), ne(invoices.status, 'canceled')))
    .limit(1);
  if (invoiced.length) throw new AppError(409, 'cancel_invoice_first', 'Cancel its invoice first');
  const uid = c.get('userId');
  const name = await userName(db, uid);
  await db.transaction(async (tx) => {
    const t = tx as unknown as Tx;
    const [locked] = await tx.update(sales).set({ status: 'canceled', canceledAt: new Date(), canceledBy: uid }).where(and(eq(sales.id, s.id), eq(sales.status, 'paid'))).returning({ id: sales.id });
    if (!locked) throw new AppError(409, 'already_canceled', 'This sale was already canceled');
    await tx.update(payments).set({ status: 'refunded' }).where(and(eq(payments.saleId, s.id), eq(payments.tenantId, tenantId)));
    const moved = await tx.select().from(stockMoves).where(and(eq(stockMoves.saleId, s.id), eq(stockMoves.reason, 'sale')));
    for (const m of moved) {
      await moveStock(t, { tenantId, productId: m.productId, locationId: m.locationId, change: -m.qtyChange, reason: 'return', saleId: s.id, note: `Cancelación de venta #${s.number}`, userId: uid, userName: name });
    }
  });
  return c.json({ ok: true });
});

/** For invoicing a sale as a whole (lib used by routes/invoicing). */
export async function saleForInvoice(db: Pick<Db, 'query' | 'select'>, tenantId: string, saleId: string) {
  const s = await db.query.sales.findFirst({ where: and(eq(sales.id, saleId), eq(sales.tenantId, tenantId)) });
  if (!s) throw notFound('sale');
  if (s.status !== 'paid') throw new AppError(422, 'payment_not_paid', 'Canceled sales are not invoiced');
  const pays = await db.select({ id: payments.id, method: payments.method, amountCents: payments.amountCents }).from(payments).where(eq(payments.saleId, s.id));
  return { sale: s, payments: pays };
}

