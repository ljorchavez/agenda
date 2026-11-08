import { Hono } from 'hono';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { appointments, customers, messageLogs, payments } from '../db/schema.js';
import {
  fetchStatus,
  verifyMercadoPagoSignature,
} from '../integrations/mercadopago.js';
import { verifyWhatsAppSignature, type WhatsAppWebhook } from '../integrations/whatsapp.js';

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
        if (!customer?.phone || customer.phone.replace(/\D/g, '') !== msg.from.replace(/\D/g, '')) {
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

  const valid = verifyMercadoPagoSignature({
    signature: c.req.header('x-signature'),
    requestId: c.req.header('x-request-id'),
    dataId,
  });
  if (!valid) return c.text('invalid signature', 401);

  // Never trust the webhook body for status: ask Mercado Pago directly.
  const { externalReference, status } = await fetchStatus(type, dataId);
  // Our external_reference is always a payments.id (uuid); ignore anything else.
  if (!externalReference || !z.string().uuid().safeParse(externalReference).success) {
    return c.text('ignored');
  }

  const db = getDb();
  const [payment] = await db
    .update(payments)
    .set({ status, paidAt: status === 'paid' ? new Date() : null })
    .where(and(eq(payments.id, externalReference), eq(payments.provider, 'mercadopago')))
    .returning();

  // A paid deposit confirms the appointment.
  if (payment?.appointmentId && status === 'paid') {
    await db
      .update(appointments)
      .set({ status: 'confirmed' })
      .where(and(eq(appointments.id, payment.appointmentId), eq(appointments.status, 'scheduled')));
  }
  return c.text('ok');
});
