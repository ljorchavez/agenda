import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { publicPurchaseSchema, type OnlinePurchase } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { offerings, payments } from '../db/schema.js';
import { purchaseToken, verifyPurchaseToken } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import { apiBaseUrl, appBaseUrl, createOnlinePayment } from '../lib/online-payments.js';
import { purchaseStatus, shopFor } from '../lib/online-sales.js';
import { findOrCreateCustomer, getTenantBySlug } from './public.js';

/** Buying a package, membership or gift card from the booking page (business's Mercado Pago). */
export const shopRoutes = new Hono();

shopRoutes.post('/public/:slug/purchases', async (c) => {
  const tenant = await getTenantBySlug(c.req.param('slug'));
  const input = publicPurchaseSchema.parse(await c.req.json());
  const db = getDb();
  const shop = await shopFor(db, tenant);
  if (!shop) throw new AppError(422, 'shop_closed', 'This business does not sell online');
  let purchase: OnlinePurchase;
  let amountCents: number;
  let title: string;
  if (input.kind === 'plan') {
    if (!shop.offerings.some((o) => o.id === input.offeringId)) throw notFound('offering');
    const o = (await db.query.offerings.findFirst({ where: and(eq(offerings.id, input.offeringId!), eq(offerings.tenantId, tenant.id)) }))!;
    purchase = { kind: 'plan', offeringId: o.id };
    amountCents = o.priceCents;
    title = `${o.name} · ${tenant.name}`;
  } else {
    if (!shop.giftCardAmounts.includes(input.amountCents!)) throw new AppError(422, 'gift_card_amount', 'Choose one of the amounts');
    purchase = { kind: 'gift_card', amountCents: input.amountCents!, recipientName: input.recipientName?.trim() || null };
    amountCents = input.amountCents!;
    title = `Tarjeta de regalo · ${tenant.name}`;
  }
  const customer = await findOrCreateCustomer(db, tenant.id, { name: input.name, phone: input.phone, email: input.email });
  const apiBase = apiBaseUrl(c.req.url);
  const payment = await createOnlinePayment(db, tenant, {
    appointmentId: null,
    purchase,
    notes: input.kind === 'plan' ? title.split(' · ')[0] : 'Tarjeta de regalo',
    customerId: customer.id,
    customerEmail: input.email ?? customer.email ?? null,
    title,
    amountCents,
    method: input.method,
    apiBase,
    // Back from Mercado Pago to the private purchase page (shows the gift card code once paid).
    backUrl: (paymentId) => `${appBaseUrl(apiBase)}/compra/${purchaseToken(paymentId)}`,
  });
  return c.json({ checkoutUrl: payment.checkoutUrl, purchasePath: `/compra/${purchaseToken(payment.id)}` }, 201);
});

/** The buyer's private purchase page: status and, once paid, the gift card code. */
shopRoutes.get('/public/purchases/:token', async (c) => {
  const id = verifyPurchaseToken(c.req.param('token'));
  if (!id) throw notFound('purchase');
  const db = getDb();
  const p = await db.query.payments.findFirst({ where: eq(payments.id, id) });
  const body = p ? await purchaseStatus(db, p) : null;
  if (!body) throw notFound('purchase');
  c.header('Cache-Control', 'private, no-store');
  return c.json(body);
});
