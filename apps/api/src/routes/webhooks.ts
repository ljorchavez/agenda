import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { appointments, customers, messageLogs, payments, tenants } from '../db/schema.js';
import { tenantMpToken } from '../lib/online-payments.js';
import {
  fetchStatus,
  verifyMercadoPagoSignature,
} from '../integrations/mercadopago.js';
import { samePhone, verifyWhatsAppSignature, type WhatsAppWebhook } from '../integrations/whatsapp.js';
import { fulfilPurchase } from '../lib/online-sales.js';
import { syncCharge, syncSubscription } from '../lib/billing.js';

/** Webhooks from WhatsApp (Meta) and Mercado Pago. Always verify signatures first. */
export const webhookRoutes = new Hono();

// ---------- WhatsApp ----------

// Meta calls this once when you register the webhook URL.
webhookRoutes.get('/webhooks/whatsapp', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');
  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return c.text(challenge ?? '');
  }
  return c.text('forbidden', 403);
});

webhookRoutes.post('/webhooks/whatsapp', async (c) => {
  const raw = await c.req.text();
  if (!verifyWhatsAppSignature(raw, c.req.header('x-hub-signature-256'))) {
    return c.text('invalid signature', 401);
  }
  const payload = JSON.parse(raw) as WhatsAppWebhook;
  const db = getDb();

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      // Delivery status updates for messages we sent
      for (const st of change.value?.statuses ?? []) {
        await db
          .update(messageLogs)
          .set({ status: st.status, error: st.errors?.[0]?.title ?? null })
          .where(eq(messageLogs.providerMessageId, st.id));
      }
      // Customer tapped "Confirmar" / "Cancelar" on the reminder
      for (const msg of change.value?.messages ?? []) {
        const payloadStr = msg.button?.payload ?? msg.interactive?.button_reply?.id;
        const match = payloadStr?.match(/^(CONFIRM|CANCEL):([0-9a-f-]{36})$/i);
        if (!match) continue;
        const [, action, appointmentId] = match;
        const appt = await db.query.appointments.findFirst({
          where: eq(appointments.id, appointmentId!),
        });
        if (!appt) continue;
        // Only accept the reply from the customer's own phone.
        const customer = await db.query.customers.findFirst({
          where: eq(customers.id, appt.customerId),
        });
        if (!customer?.phone || !samePhone(customer.phone, msg.from)) {
          continue;
        }
        await db
          .update(appointments)
          .set({ status: action!.toUpperCase() === 'CONFIRM' ? 'confirmed' : 'cancelled' })
          .where(
            and(
              eq(appointments.id, appt.id),
              inArray(appointments.status, ['scheduled', 'confirmed']),
            ),
          );
      }
    }
  }
  return c.text('ok');
});

// ---------- Mercado Pago ----------

webhookRoutes.post('/webhooks/mercadopago', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    type?: string;
    topic?: string;
    data?: { id?: string | number };
  };
  const dataId = String(body.data?.id ?? c.req.query('data.id') ?? '');
  const type = body.type ?? body.topic ?? c.req.query('type');
  if (!dataId || (type !== 'payment' && type !== 'order')) return c.text('ignored');

  const db = getDb();
  // Payments created with a business's own account carry ?tenant=<id>. We don't have that
  // account's webhook secret, but we never trust the body: the status is fetched from
  // Mercado Pago with the business's token and must match one of that business's payments.
  const tenantId = c.req.query('tenant');
  let accessToken: string | null = null;
  if (tenantId) {
    if (!z.string().uuid().safeParse(tenantId).success) return c.text('ignored');
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    accessToken = tenant ? tenantMpToken(tenant) : null;
    if (!accessToken) return c.text('ignored');
  } else {
    const valid = verifyMercadoPagoSignature({
      signature: c.req.header('x-signature'),
      requestId: c.req.header('x-request-id'),
      dataId,
    });
    if (!valid) return c.text('invalid signature', 401);
  }

  // Never trust the webhook body for status: ask Mercado Pago directly.
  const { externalReference, status } = await fetchStatus(type, dataId, accessToken);
  // Our external_reference is always a payments.id (uuid); ignore anything else.
  if (!externalReference || !z.string().uuid().safeParse(externalReference).success) {
    return c.text('ignored');
  }

  const [payment] = await db
    .update(payments)
    .set({ status, paidAt: status === 'paid' ? new Date() : null })
    .where(
      and(
        eq(payments.id, externalReference),
        eq(payments.provider, 'mercadopago'),
        ...(tenantId ? [eq(payments.tenantId, tenantId)] : []),
      ),
    )
    .returning();

  // A paid online sale creates the package/membership or gift card (once).
  if (payment?.purchase && status === 'paid') await fulfilPurchase(db, payment.id);

  // A paid deposit confirms the appointment.
  if (payment?.appointmentId && status === 'paid') {
    await db
      .update(appointments)
      .set({ status: 'confirmed' })
      .where(and(eq(appointments.id, payment.appointmentId), eq(appointments.status, 'scheduled')));
  }
  return c.text('ok');
});

// ---------- Subscriptions (Lugali's own Mercado Pago account) ----------

/**
 * Mercado Pago "Planes y suscripciones" notifications. Whatever the body says, the state is read
 * back from Mercado Pago with our token, so a forged call can at most trigger a re-check.
 */
webhookRoutes.post('/webhooks/billing', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { type?: string; topic?: string; data?: { id?: string | number } };
  const type = body.type ?? body.topic ?? c.req.query('type') ?? c.req.query('topic') ?? '';
  const id = String(body.data?.id ?? c.req.query('data.id') ?? c.req.query('id') ?? '');
  if (!id || !/^[\w-]{1,64}$/.test(id)) return c.json({ ok: true });
  const secret = process.env.MERCADOPAGO_BILLING_WEBHOOK_SECRET?.trim();
  if (secret && !verifyMercadoPagoSignature({ signature: c.req.header('x-signature'), requestId: c.req.header('x-request-id'), dataId: id, secret })) {
    return c.text('invalid signature', 401);
  }
  const db = getDb();
  if (type.includes('preapproval')) await syncSubscription(db, id);
  else if (type.includes('authorized_payment')) await syncCharge(db, id);
  return c.json({ ok: true });
});
