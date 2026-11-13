import { Hono } from 'hono';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  isHealthType,
  posSettingsOf,
  posSettingsSchema,
  productImportSchema,
  productInputSchema,
  saleCreateSchema,
  saleTotal,
  stockAdjustSchema,
  type PosHeaderDto,
  type ProductImportResult,
  type TenantSettings,
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
import { planImport, type Existing } from '../lib/product-import.js';
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
    number: p.number ?? null,
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

/**
 * Inventory from a spreadsheet: rows with an ID update that product, rows without one create it;
 * "Existencia" sets the count at the location. `dryRun` (default) only says what would change;
 * otherwise the valid rows are applied together and the ones with errors are skipped.
 */
posRoutes.post('/products/import', requireBusinessManager, async (c) => {
  const input = productImportSchema.parse(await c.req.json());
  const db = getDb();
  const tenantId = c.get('tenantId');
  await assertFeature(db, tenantId, 'cash');
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId), columns: { businessType: true } });
  const locationId = (await locationForWrite(db, c, input.locationId, { create: true }))!;
  const all = await db.select().from(products).where(eq(products.tenantId, tenantId));
  const stock = await stockMap(db, tenantId, all.map((p) => p.id));
  const existing = new Map<string, Existing>();
  for (const p of all) {
    const e: Existing = { id: p.id, input: productValues(p as never) as Existing['input'], stock: stock.get(p.id)?.[locationId] ?? 0 };
    existing.set(p.id, e);
    if (p.number != null) existing.set(String(p.number), e);
  }
  const plan = planImport(input.table, existing, { health: isHealthType(tenant?.businessType ?? 'other') });
  if (plan.headerError) throw new AppError(422, plan.headerError, 'The first row must have the column names (Producto, Precio…)');
  const result: ProductImportResult = {
    rows: plan.rows.map(({ row, action, name, changes, error }) => ({ row, action, name, changes, ...(error ? { error } : {}) })),
    created: plan.rows.filter((r) => r.action === 'create').length,
    updated: plan.rows.filter((r) => r.action === 'update').length,
    unchanged: plan.rows.filter((r) => r.action === 'unchanged').length,
    errors: plan.rows.filter((r) => r.action === 'error').length,
    applied: false,
    ignored: plan.ignored,
  };
  if (input.dryRun || !(result.created + result.updated)) return c.json(result);

  const uid = c.get('userId');
  const name = await userName(db, uid);
  await db.transaction(async (tx) => {
    for (const r of plan.rows) {
      if (r.action === 'create' && r.values) {
        const [row] = await tx.insert(products).values({ tenantId, ...productValues(r.values) }).returning({ id: products.id });
        if (r.stock) await moveStock(tx as unknown as Tx, { tenantId, productId: row!.id, locationId, change: r.stock, reason: 'in', note: 'Carga de Excel', userId: uid, userName: name });
      } else if (r.action === 'update' && r.values && r.id) {
        if (r.changes.some((f) => f !== 'stock')) {
          await tx.update(products).set({ ...productValues(r.values), updatedAt: new Date() }).where(and(eq(products.id, r.id), eq(products.tenantId, tenantId)));
        }
        if (r.stock !== undefined) {
          await tx.execute(sql`select 1 from product_stock where product_id = ${r.id} and location_id = ${locationId} for update`);
          const cur = (await tx.query.productStock.findFirst({ where: and(eq(productStock.productId, r.id), eq(productStock.locationId, locationId)) }))?.qty ?? 0;
          if (r.stock !== cur) await moveStock(tx as unknown as Tx, { tenantId, productId: r.id, locationId, change: r.stock - cur, reason: 'adjust', note: 'Actualización por Excel', userId: uid, userName: name });
        }
      }
    }
  });
  return c.json({ ...result, applied: true });
});

/**
 * What a barcode is, from the free Open Food Facts / Open Beauty Facts databases (food, drinks,
 * cosmetics, hair products). Many local products aren't there: then nothing is found.
 */
let lookupFetch: typeof fetch = (...a) => fetch(...a);
export const setLookupFetch = (fn: typeof fetch | null) => {
  lookupFetch = fn ?? ((...a) => fetch(...a));
};
posRoutes.get('/products/lookup', requireBusinessManager, async (c) => {
  const code = (c.req.query('code') ?? '').replace(/\D/g, '');
  if (code.length < 8 || code.length > 14) return c.json({ found: false });
  for (const [host, source] of [['world.openfoodfacts.org', 'Open Food Facts'], ['world.openbeautyfacts.org', 'Open Beauty Facts']] as const) {
    try {
      const r = await lookupFetch(`https://${host}/api/v2/product/${code}.json?fields=product_name,product_name_es,brands,quantity`, {
        headers: { 'user-agent': 'Lugali/1.0 (https://www.lugali.com)' },
        signal: AbortSignal.timeout(4000),
      });
      if (!r.ok) continue;
      const j = (await r.json()) as { status?: number; product?: { product_name?: string; product_name_es?: string; brands?: string; quantity?: string } };
      const p = j.product;
      const name = (p?.product_name_es || p?.product_name || '').trim();
      if (j.status !== 1 || !name) continue;
      const brand = (p?.brands ?? '').split(',')[0]?.trim() || null;
      const quantity = p?.quantity?.trim() || null;
      // "Shampoo anticaspa" + "Head & Shoulders" + "375 ml"
      const full = [name, brand && !name.toLowerCase().includes(brand.toLowerCase()) ? brand : null, quantity && !name.toLowerCase().includes(quantity.toLowerCase()) ? quantity : null]
        .filter(Boolean)
        .join(' ')
        .slice(0, 120);
      return c.json({ found: true, name: full, brand, quantity, source });
    } catch {
      /* try the next one */
    }
  }
  return c.json({ found: false });
});

/** Point-of-sale settings: what happens without stock, and the category list. */
posRoutes.get('/pos/settings', async (c) => {
  const t = await getDb().query.tenants.findFirst({ where: eq(tenants.id, c.get('tenantId')), columns: { settings: true } });
  return c.json(posSettingsOf(t?.settings as TenantSettings | null));
});

posRoutes.put('/pos/settings', requireBusinessManager, async (c) => {
  const input = posSettingsSchema.parse(await c.req.json());
  const db = getDb();
  const tenantId = c.get('tenantId');
  const categories = [...new Map(input.categories.map((x) => [x.toLocaleLowerCase('es'), x])).values()].sort((a, b) => a.localeCompare(b, 'es'));
  const value = { stockPolicy: input.stockPolicy, categories };
  await db.execute(sql`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{pos}', ${JSON.stringify(value)}::jsonb), updated_at = now() where id = ${tenantId}`);
  return c.json(value);
});

/** Renames a category on every product (and in the list); `to: null` takes it off them. */
posRoutes.post('/products/categories/rename', requireBusinessManager, async (c) => {
  const input = z.object({ from: z.string().trim().min(1).max(60), to: z.string().trim().min(1).max(60).nullable() }).parse(await c.req.json());
  const db = getDb();
  const tenantId = c.get('tenantId');
  const changed = await db
    .update(products)
    .set({ category: input.to, updatedAt: new Date() })
    .where(and(eq(products.tenantId, tenantId), sql`lower(${products.category}) = lower(${input.from})`))
    .returning({ id: products.id });
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId), columns: { settings: true } });
  const cur = posSettingsOf(t?.settings as TenantSettings | null);
  const list = cur.categories.filter((x) => x.toLocaleLowerCase('es') !== input.from.toLocaleLowerCase('es'));
  if (input.to && !list.some((x) => x.toLocaleLowerCase('es') === input.to!.toLocaleLowerCase('es'))) list.push(input.to);
  list.sort((a, b) => a.localeCompare(b, 'es'));
  await db.execute(sql`update tenants set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{pos}', ${JSON.stringify({ ...cur, categories: list })}::jsonb), updated_at = now() where id = ${tenantId}`);
  return c.json({ products: changed.length, categories: list });
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
      offline: s.offline,
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

/** The sale this device already sent (a retry after a cut): answered as if just made. */
async function existingSale(db: Db, tenantId: string, clientId: string) {
  const [row] = await saleSelect(db).where(and(eq(sales.tenantId, tenantId), eq(sales.clientId, clientId))).limit(1);
  if (!row) return null;
  const [dto] = await saleDtos(db, tenantId, [{ ...row.s, locationName: row.locationName, customerName: row.customerName }]);
  return dto!;
}

/** When an offline sale really happened: its device time, if believable (last 7 days, not ahead). */
function saleDate(input: { offline?: boolean; soldAt?: string }): Date {
  const now = Date.now();
  if (!input.offline || !input.soldAt) return new Date(now);
  const t = Date.parse(input.soldAt);
  return t > now - 7 * 86_400_000 && t < now + 5 * 60_000 ? new Date(t) : new Date(now);
}

posRoutes.post('/sales', async (c) => {
  const input = saleCreateSchema.parse(await c.req.json());
  const db = getDb();
  const tenantId = c.get('tenantId');
  if (input.clientId) {
    const prev = await existingSale(db, tenantId, input.clientId);
    if (prev) return c.json(prev, 200);
  }
  await assertFeature(db, tenantId, 'cash');
  const locationId = (await locationForWrite(db, c, input.locationId, { create: true }))!;
  const offline = Boolean(input.offline);
  const owner = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId), columns: { settings: true } });
  // The business decides: stop the sale, or sell and let stock go below zero
  const blockNoStock = posSettingsOf(owner?.settings as TenantSettings | null).stockPolicy === 'block';
  const customer = input.customerId
    ? await db.query.customers.findFirst({ where: and(eq(customers.id, input.customerId), eq(customers.tenantId, tenantId)) })
    : null;
  // A customer deleted while the register was offline doesn't block the sale
  if (input.customerId && !customer && !offline) throw notFound('customer');

  const productIds = [...new Set(input.items.map((i) => i.productId).filter((x): x is string => Boolean(x)))];
  const prods = productIds.length ? await db.select().from(products).where(and(eq(products.tenantId, tenantId), inArray(products.id, productIds))) : [];
  const byId = new Map(prods.map((p) => [p.id, p]));
  const items: SaleItem[] = input.items.map((i) => {
    if (i.productId) {
      const p = byId.get(i.productId);
      if (p && (p.active || offline)) {
        // The price on the ticket is the one charged, even if it changed in the meantime
        const unit = i.unitCents ?? p.priceCents;
        return { productId: p.id, name: p.name, qty: i.qty, unitCents: unit, totalCents: unit * i.qty, iva: p.iva, satKey: p.satKey };
      }
      // Sold offline but deleted since: keep the sale as a free line with what the ticket said
      if (!offline || !i.name || i.unitCents == null) throw notFound('product');
    }
    return { productId: null, name: i.name!, qty: i.qty, unitCents: i.unitCents!, totalCents: i.unitCents! * i.qty, iva: '16', satKey: null };
  });
  const total = saleTotal(items);
  const paid = input.payments.reduce((a, p) => a + p.amountCents, 0);
  if (paid !== total) throw new AppError(422, 'payments_mismatch', 'Payments must add up to the total', { totalCents: total, paidCents: paid });

  const uid = c.get('userId');
  const name = await userName(db, uid);
  const when = saleDate(input);
  let sale: Sale;
  try {
    sale = await db.transaction(async (tx) => {
      const t = tx as unknown as Tx;
      // One number per business, in order
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'sales:' + tenantId}))`);
      const next = await tx.execute<{ n: number }>(sql`select coalesce(max(number), 0) + 1 as n from sales where tenant_id = ${tenantId}`);
      const [s] = await tx
        .insert(sales)
        .values({
          tenantId, locationId, number: Number(next.rows[0]!.n), customerId: customer?.id ?? null, items, totalCents: total, notes: input.notes,
          createdBy: uid, createdByName: name, createdAt: when, clientId: input.clientId ?? null, offline,
        })
        .returning();
      for (const it of items) {
        const p = it.productId ? byId.get(it.productId) : null;
        if (!p?.trackStock) continue;
        const left = await moveStock(t, { tenantId, productId: p.id, locationId, change: -it.qty, reason: 'sale', saleId: s!.id, userId: uid, userName: name });
        // Offline the money was already taken: stock may go below zero (shown to fix later)
        if (left < 0 && !offline && blockNoStock) throw new AppError(409, 'insufficient_stock', `Not enough ${p.name}`, { productId: p.id, name: p.name, available: left + it.qty });
      }
      const payer = customer?.id ?? (await walkInCustomer(t, tenantId));
      for (const p of input.payments.filter((x) => x.amountCents > 0)) {
        await tx.insert(payments).values({
          tenantId, customerId: payer, amountCents: p.amountCents, method: p.method, status: 'paid', paidAt: when,
          locationId, saleId: s!.id, notes: `Venta #${s!.number}`,
        });
      }
      return s!;
    });
  } catch (e) {
    // Two copies of the same sale arrived at once: the other one won
    if (input.clientId && /sales_tenant_client_idx|duplicate key/.test(String((e as { message?: string }).message ?? e))) {
      const prev = await existingSale(db, tenantId, input.clientId);
      if (prev) return c.json(prev, 200);
    }
    throw e;
  }
  const loc = await db.query.locations.findFirst({ where: eq(locations.id, locationId), columns: { name: true } });
  const [dto] = await saleDtos(db, tenantId, [{ ...sale, locationName: loc?.name ?? null, customerName: customer?.name ?? null }]);
  return c.json(dto, 201);
});

/** Business data for the location's tickets: the register keeps it to print without internet. */
async function ticketHeader(db: Db, tenantId: string, locationId: string): Promise<PosHeaderDto> {
  const t = (await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) }))!;
  const loc = await db.query.locations.findFirst({ where: and(eq(locations.id, locationId), eq(locations.tenantId, tenantId)) });
  const active = await db.select({ id: locations.id }).from(locations).where(and(eq(locations.tenantId, tenantId), eq(locations.active, true)));
  // The location's own address, else the business profile's
  const src = loc && (loc.address || !loc.isPrimary) ? loc : t;
  const address = [src.address, src.neighborhood, src.city, src.state].filter(Boolean).join(', ') || null;
  const inv = t.settings.invoicing;
  return {
    business: { name: t.name, legalName: inv?.legalName || null, rfc: inv?.rfc || null, address, phone: loc?.phone ?? t.phone },
    locationName: loc?.name ?? null,
    multiLocation: active.length > 1,
    timezone: t.timezone,
    invoicing: Boolean(t.invoicingEnc),
  };
}

posRoutes.get('/pos/header', async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const locationId = (await locationForWrite(db, c, c.req.query('locationId') || undefined, { create: true }))!;
  return c.json(await ticketHeader(db, tenantId, locationId));
});

/** Data for the printed ticket of a sale. */
posRoutes.get('/sales/:id/ticket', async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const scope = await getScope(db, c);
  const [row] = await saleSelect(db).where(and(eq(sales.id, c.req.param('id')), eq(sales.tenantId, tenantId))).limit(1);
  if (!row) throw notFound('sale');
  if (scope.personal && row.s.createdBy !== scope.userId) throw notFound('sale');
  const [sale] = await saleDtos(db, tenantId, [{ ...row.s, locationName: row.locationName, customerName: row.customerName }]);
  const out: SaleTicketDto = {
    ...(await ticketHeader(db, tenantId, row.s.locationId)),
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

