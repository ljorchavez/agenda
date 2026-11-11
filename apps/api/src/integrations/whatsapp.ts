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
 *   "Hola {{1}}, te recordamos que tienes una cita en {{2}} el {{3}} a las {{4}}. …"
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

/**
 * Same phone, as WhatsApp writes Mexican mobiles: "521..." (old format) and "52..." are one number.
 */
export function samePhone(a: string, b: string): boolean {
  const norm = (x: string) => {
    const d = x.replace(/\D/g, '');
    return d.length === 13 && d.startsWith('521') ? `52${d.slice(3)}` : d;
  };
  return norm(a) !== '' && norm(a) === norm(b);
}

/**
 * Demo businesses (slug "*-demo") are public and their customers' phones are made up, so they
 * only message the numbers listed in WHATSAPP_TEST_TO (comma-separated). Real businesses always can.
 */
export function whatsappAllowedFor(slug: string, phone: string): boolean {
  if (!slug.endsWith('-demo')) return true;
  return (process.env.WHATSAPP_TEST_TO ?? '')
    .split(',')
    .map((x) => x.trim())
    .some((x) => x !== '' && samePhone(x, phone));
}

/** Any approved template with text variables (and an optional URL button suffix). */
export async function sendTemplate(p: { to: string; template: string; params: string[]; urlSuffix?: string }): Promise<SendResult> {
  const body = {
    messaging_product: 'whatsapp',
    to: p.to.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: p.template,
      language: { code: process.env.WHATSAPP_TEMPLATE_LANG ?? 'es_MX' },
      components: [
        { type: 'body', parameters: p.params.map((text) => ({ type: 'text', text })) },
        ...(p.urlSuffix ? [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: p.urlSuffix }] }] : []),
      ],
    },
  };
  if (!isWhatsAppConfigured()) {
    console.info('[whatsapp:dry_run]', JSON.stringify(body));
    return { status: 'dry_run' };
  }
  try {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { messages?: { id: string }[]; error?: { message: string } };
    if (!res.ok) return { status: 'failed', error: json.error?.message ?? `HTTP ${res.status}` };
    return { status: 'sent', providerMessageId: json.messages?.[0]?.id };
  } catch (err) {
    return { status: 'failed', error: (err as Error).message };
  }
}

/**
 * Templates this app uses, created in the WhatsApp Business Account on deploy if missing (Meta
 * reviews them; utility templates are usually approved in minutes).
 */
export const WHATSAPP_TEMPLATES = [
  {
    name: process.env.WHATSAPP_REMINDER_TEMPLATE ?? 'appointment_reminder',
    category: 'UTILITY',
    components: [
      { type: 'BODY', text: 'Hola {{1}}, te recordamos que tienes una cita en {{2}} el {{3}} a las {{4}}. Usa los botones de abajo para confirmar tu asistencia o cancelar la cita. ¡Te esperamos!', example: { body_text: [['Ana', 'Consultorio Demo', 'jueves 12 de noviembre', '11:00']] } },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Confirmar' }, { type: 'QUICK_REPLY', text: 'Cancelar' }] },
    ],
  },
  {
    name: process.env.WHATSAPP_CONFIRMATION_TEMPLATE ?? 'appointment_booked',
    category: 'UTILITY',
    components: [
      { type: 'BODY', text: 'Hola {{1}}, tu cita en {{2}} quedó agendada para el {{3}} a las {{4}}. Puedes verla, cambiarla o cancelarla aquí:', example: { body_text: [['Ana', 'Consultorio Demo', 'jueves 12 de noviembre', '11:00']] } },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Ver mi cita', url: `${(process.env.APP_URL ?? 'https://agenda-crm-rouge.vercel.app').replace(/\/$/, '')}/c/{{1}}`, example: ['abc123'] }] },
    ],
  },
];

/** Creates the missing templates (needs WHATSAPP_WABA_ID). Returns what it did, for the build log. */
export async function ensureWhatsAppTemplates(): Promise<string> {
  const waba = process.env.WHATSAPP_WABA_ID;
  if (!isWhatsAppConfigured() || !waba) return 'WhatsApp not configured: skipped templates';
  const base = `https://graph.facebook.com/${GRAPH_VERSION}/${waba}/message_templates`;
  const auth = { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` };
  const list = (await (await fetch(`${base}?fields=name,status,language&limit=200`, { headers: auth })).json()) as { data?: { name: string; status: string }[] };
  const out: string[] = [];
  for (const t of WHATSAPP_TEMPLATES) {
    const found = list.data?.find((x) => x.name === t.name);
    if (found) {
      out.push(`${t.name}: ${found.status}`);
      continue;
    }
    const res = await fetch(base, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: t.name, language: process.env.WHATSAPP_TEMPLATE_LANG ?? 'es_MX', category: t.category, components: t.components }),
    });
    const json = (await res.json()) as { status?: string; error?: { message?: string; error_user_title?: string; error_user_msg?: string } };
    const why = [json.error?.message, json.error?.error_user_title, json.error?.error_user_msg].filter(Boolean).join(' · ');
    out.push(`${t.name}: ${res.ok ? `created (${json.status ?? 'PENDING'})` : `error ${why || res.status}`}`);
  }
  return out.join('; ');
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
