import { Hono } from 'hono';
import { and, desc, eq, ne } from 'drizzle-orm';
import {
  PAYMENT_FORMS,
  PUBLIC_RFC,
  invoiceCancelSchema,
  invoiceRequestSchema,
  invoicingDefaultsFor,
  invoicingSettingsSchema,
  type InvoiceDto,
  type InvoicingSettings,
  type InvoicingStatusDto,
} from '@agenda/shared';
import { getDb } from '../db/client.js';
import { customers, invoices, payments, tenants, type Invoice, type Tenant } from '../db/schema.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import {
  cancelInvoice,
  createInvoice,
  createOrganization,
  emailInvoice,
  facturapiAvailable,
  invoiceFile,
  renewLiveKey,
  testKey,
  updateLegal,
  uploadCertificate,
  type InvoiceInput,
} from '../integrations/facturapi.js';
import { requireManager, requireOwner, type AppEnv } from '../middleware/auth.js';

/**
 * Electronic invoicing (CFDI 4.0) through Facturapi. The owner enters the business's fiscal data
 * (that creates its issuer in Facturapi, with test invoices right away) and uploads the CSD to
 * issue real ones. Managers invoice a paid payment, to the customer's RFC or to "público en
 * general"; download PDF/XML, email it, or cancel it.
 */
export const invoicingRoutes = new Hono<AppEnv>();

interface Keys {
  orgId: string;
  testKey: string;
  liveKey: string | null;
}
const keysOf = (t: Tenant): Keys | null => {
  if (!t.invoicingEnc) return null;
  try {
    return JSON.parse(decryptSecret(t.invoicingEnc)) as Keys;
  } catch {
    return null;
  }
};
const tenantOf = async (id: string) => (await getDb().query.tenants.findFirst({ where: eq(tenants.id, id) }))!;

function status(t: Tenant): InvoicingStatusDto {
  const k = keysOf(t);
  return {
    available: facturapiAvailable(),
    settings: t.settings.invoicing ?? null,
    connected: Boolean(k),
    live: Boolean(k?.liveKey),
    defaults: invoicingDefaultsFor(t.businessType),
  };
}

const toDto = (i: Invoice): InvoiceDto => ({
  id: i.id,
  paymentId: i.paymentId,
  customerId: i.customerId,
  uuid: i.uuid,
  series: i.series,
  folio: i.folio,
  totalCents: i.totalCents,
  status: i.status,
  test: i.test,
  createdAt: i.createdAt.toISOString(),
});

invoicingRoutes.get('/invoicing', requireManager, async (c) => c.json(status(await tenantOf(c.get('tenantId')))));

/** Fiscal data of the business: creates (or updates) its issuer in Facturapi. */
invoicingRoutes.put('/invoicing', requireOwner, async (c) => {
  const input = invoicingSettingsSchema.parse(await c.req.json());
  const db = getDb();
  const t = await tenantOf(c.get('tenantId'));
  // Before the platform turns invoicing on, the data is just kept; the issuer is created later.
  if (!facturapiAvailable()) {
    await db.update(tenants).set({ settings: { ...t.settings, invoicing: input }, updatedAt: new Date() }).where(eq(tenants.id, t.id));
    return c.json(status(await tenantOf(t.id)));
  }
  let keys = keysOf(t);
  if (!keys) {
    const org = await createOrganization(t.name);
    keys = { orgId: org.id, testKey: await testKey(org.id), liveKey: null };
  }
  await updateLegal(keys.orgId, { name: t.name, legal_name: input.legalName, tax_system: input.taxSystem, address: { zip: input.zip } });
  await db
    .update(tenants)
    .set({ settings: { ...t.settings, invoicing: input }, invoicingEnc: encryptSecret(JSON.stringify(keys)), updatedAt: new Date() })
    .where(eq(tenants.id, t.id));
  return c.json(status(await tenantOf(t.id)));
});

/** CSD (.cer, .key and its password): from now on invoices are real. Files are not kept here. */
invoicingRoutes.put('/invoicing/certificate', requireOwner, async (c) => {
  const t = await tenantOf(c.get('tenantId'));
  const keys = keysOf(t);
  if (!keys) throw new AppError(409, 'invoicing_not_set', 'Enter the fiscal data first');
  const body = await c.req.parseBody();
  const cer = body['cer'];
  const key = body['key'];
  const password = body['password'];
  if (!(cer instanceof File) || !(key instanceof File) || typeof password !== 'string' || !password) {
    throw new AppError(422, 'validation_error', 'Send the .cer, the .key and the password');
  }
  if (cer.size > 50_000 || key.size > 50_000) throw new AppError(422, 'validation_error', 'Those files are too big for a CSD');
  await uploadCertificate(keys.orgId, cer, key, password);
  const live = await renewLiveKey(keys.orgId);
  await getDb()
    .update(tenants)
    .set({ invoicingEnc: encryptSecret(JSON.stringify({ ...keys, liveKey: live })), updatedAt: new Date() })
    .where(eq(tenants.id, t.id));
  return c.json(status(await tenantOf(t.id)));
});

const taxesFor = (iva: InvoicingSettings['iva']): InvoiceInput['items'][number]['product']['taxes'] =>
  iva === 'exento' ? [{ type: 'IVA', factor: 'Exento' }] : [{ type: 'IVA', rate: iva === '16' ? 0.16 : 0 }];

/** Invoices a paid payment. Test invoices until the CSD is uploaded. */
invoicingRoutes.post('/payments/:id/invoice', requireManager, async (c) => {
  const db = getDb();
  const t = await tenantOf(c.get('tenantId'));
  const keys = keysOf(t);
  const cfg = t.settings.invoicing;
  if (!facturapiAvailable() || !keys || !cfg) throw new AppError(409, 'invoicing_not_set', 'Set up invoicing first');
  const p = await db.query.payments.findFirst({ where: and(eq(payments.id, c.req.param('id')), eq(payments.tenantId, t.id)) });
  if (!p) throw notFound('payment');
  if (p.status !== 'paid') throw new AppError(422, 'payment_not_paid', 'Only paid payments are invoiced');
  const existing = await db.query.invoices.findFirst({ where: and(eq(invoices.paymentId, p.id), ne(invoices.status, 'canceled')) });
  if (existing) throw new AppError(409, 'already_invoiced', 'This payment already has an invoice');
  const input = invoiceRequestSchema.parse(await c.req.json());
  const cu = await db.query.customers.findFirst({ where: eq(customers.id, p.customerId) });
  const f = input.customer;
  const receiver: InvoiceInput['customer'] = f
    ? { legal_name: f.legalName, tax_id: f.rfc, tax_system: f.taxSystem, address: { zip: f.zip }, ...(f.email ? { email: f.email } : cu?.email ? { email: cu.email } : {}) }
    : { legal_name: 'PUBLICO EN GENERAL', tax_id: PUBLIC_RFC, tax_system: '616', address: { zip: cfg.zip } };
  const live = Boolean(keys.liveKey);
  const inv = await createInvoice((keys.liveKey ?? keys.testKey) as string, {
    customer: receiver,
    items: [{ quantity: 1, product: { description: cfg.description, product_key: cfg.productKey, price: p.amountCents / 100, tax_included: true, taxes: taxesFor(cfg.iva) } }],
    payment_form: PAYMENT_FORMS[p.method] ?? '99',
    payment_method: 'PUE',
    use: f ? f.use : 'S01',
    ...(cfg.series ? { series: cfg.series } : {}),
  });
  if (f && input.save && cu) await db.update(customers).set({ fiscal: f }).where(eq(customers.id, cu.id));
  const [row] = await db
    .insert(invoices)
    .values({
      tenantId: t.id,
      paymentId: p.id,
      customerId: p.customerId,
      facturapiId: inv.id,
      uuid: inv.uuid ?? null,
      series: inv.series ?? null,
      folio: inv.folio_number ?? null,
      totalCents: Math.round(inv.total * 100),
      status: inv.status === 'canceled' ? 'canceled' : 'valid',
      test: !live,
      receiverRfc: receiver.tax_id,
      createdBy: c.get('userId'),
    })
    .returning();
  if (cfg.autoEmail && receiver.email) await emailInvoice((keys.liveKey ?? keys.testKey) as string, inv.id).catch(() => undefined);
  return c.json(toDto(row!), 201);
});

invoicingRoutes.get('/invoices', requireManager, async (c) => {
  const rows = await getDb().select().from(invoices).where(eq(invoices.tenantId, c.get('tenantId'))).orderBy(desc(invoices.createdAt)).limit(500);
  return c.json(rows.map(toDto));
});

async function loadInvoice(tenantId: string, id: string) {
  const i = await getDb().query.invoices.findFirst({ where: and(eq(invoices.id, id), eq(invoices.tenantId, tenantId)) });
  if (!i) throw notFound('invoice');
  const t = await tenantOf(tenantId);
  const keys = keysOf(t);
  if (!keys) throw new AppError(409, 'invoicing_not_set', 'Set up invoicing first');
  // Test invoices live under the test key
  return { i, key: (i.test ? keys.testKey : keys.liveKey ?? keys.testKey) as string };
}

/** PDF or XML, streamed from Facturapi. */
invoicingRoutes.get('/invoices/:id/:kind{pdf|xml}', requireManager, async (c) => {
  const { i, key } = await loadInvoice(c.get('tenantId'), c.req.param('id'));
  const kind = c.req.param('kind') as 'pdf' | 'xml';
  const res = await invoiceFile(key, i.facturapiId, kind);
  const name = `${i.series ?? 'F'}${i.folio ?? ''}-${i.uuid ?? i.id}.${kind}`;
  return new Response(res.body, {
    headers: {
      'content-type': kind === 'pdf' ? 'application/pdf' : 'application/xml',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'private, no-store',
    },
  });
});

invoicingRoutes.post('/invoices/:id/email', requireManager, async (c) => {
  const { i, key } = await loadInvoice(c.get('tenantId'), c.req.param('id'));
  const body = (await c.req.json().catch(() => ({}))) as { email?: string };
  await emailInvoice(key, i.facturapiId, typeof body.email === 'string' && body.email.includes('@') ? body.email : undefined);
  return c.json({ ok: true });
});

/** Cancels before the SAT: 02 = errors without relation, 03 = the operation didn't happen. */
invoicingRoutes.post('/invoices/:id/cancel', requireManager, async (c) => {
  const { i, key } = await loadInvoice(c.get('tenantId'), c.req.param('id'));
  if (i.status === 'canceled') throw new AppError(409, 'already_canceled', 'Already canceled');
  const { motive } = invoiceCancelSchema.parse(await c.req.json());
  const res = await cancelInvoice(key, i.facturapiId, motive);
  // The SAT may need the receiver's acceptance: Facturapi reports "pending" until then
  const st = res.status === 'canceled' ? 'canceled' : 'pending';
  const [row] = await getDb()
    .update(invoices)
    .set({ status: st, canceledAt: st === 'canceled' ? new Date() : null })
    .where(eq(invoices.id, i.id))
    .returning();
  return c.json(toDto(row!));
});
