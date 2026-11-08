import crypto from 'node:crypto';

/**
 * WhatsApp Cloud API (Meta) client.
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 *
 * If WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID are not set, messages are logged and
 * reported as `dry_run`, so the whole flow can be tested locally without Meta credentials.
 */

const GRAPH_VERSION = 'v21.0';

export interface ReminderParams {
  to: string; // E.164, e.g. +5215512345678
  customerName: string;
  businessName: string;
  date: string; // already formatted in the tenant's locale/timezone
  time: string;
  appointmentId: string;
}

export interface SendResult {
  status: 'sent' | 'dry_run' | 'failed';
  providerMessageId?: string;
  error?: string;
}

export function isWhatsAppConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

/**
 * Sends the reminder template. The template (category "utility") must be approved in
 * Meta Business Manager with 4 body variables and 2 quick-reply buttons:
 *   "Hola {{1}}, te recordamos tu cita en {{2}} el {{3}} a las {{4}}."
 *   [Confirmar] [Cancelar]
 * Button payloads come back in the webhook as CONFIRM:<appointmentId> / CANCEL:<appointmentId>.
 */
export async function sendReminder(p: ReminderParams): Promise<SendResult> {
  const template = process.env.WHATSAPP_REMINDER_TEMPLATE ?? 'appointment_reminder';
  const lang = process.env.WHATSAPP_TEMPLATE_LANG ?? 'es_MX';
  const body = {
    messaging_product: 'whatsapp',
    to: p.to.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: template,
      language: { code: lang },
      components: [
        {
          type: 'body',
          parameters: [p.customerName, p.businessName, p.date, p.time].map((text) => ({
            type: 'text',
            text,
          })),
        },
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '0',
          parameters: [{ type: 'payload', payload: `CONFIRM:${p.appointmentId}` }],
        },
        {
          type: 'button',
          sub_type: 'quick_reply',
          index: '1',
          parameters: [{ type: 'payload', payload: `CANCEL:${p.appointmentId}` }],
        },
      ],
    },
  };

  if (!isWhatsAppConfigured()) {
    console.info('[whatsapp:dry_run]', JSON.stringify(body));
    return { status: 'dry_run' };
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    const json = (await res.json()) as { messages?: { id: string }[]; error?: { message: string } };
    if (!res.ok) return { status: 'failed', error: json.error?.message ?? `HTTP ${res.status}` };
    return { status: 'sent', providerMessageId: json.messages?.[0]?.id };
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
}

/** Validates the X-Hub-Signature-256 header Meta sends with every webhook. */
export function verifyWhatsAppSignature(rawBody: string, header: string | undefined): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production'; // allow local testing
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const given = header.slice('sha256='.length);
  return (
    expected.length === given.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))
  );
}

/** Minimal subset of the webhook payload we care about. */
export interface WhatsAppWebhook {
  entry?: {
    changes?: {
      value?: {
        statuses?: { id: string; status: string; errors?: { title?: string }[] }[];
        messages?: {
          from: string;
          type: string;
          button?: { payload?: string; text?: string };
          interactive?: { button_reply?: { id?: string } };
        }[];
      };
    }[];
  }[];
}
