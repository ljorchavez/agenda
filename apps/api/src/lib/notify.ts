/**
 * Emails to the customer about their booking: confirmation when it's made, changes, cancellation
 * and the reminder before it. Only when the customer has an email; never fails the request.
 */
import { sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { businessKind, isHealthType, type BusinessType } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { messageLogs } from '../db/schema.js';
import { manageToken, portalToken } from './crypto.js';
import { escapeHtml, sendEmail } from './email.js';
import { isWhatsAppConfigured, sendTemplate, whatsappAllowedFor, WHATSAPP_TEMPLATES } from '../integrations/whatsapp.js';

export type AppointmentEmail = 'booked' | 'rescheduled' | 'cancelled' | 'reminder';

type Row = {
  id: string;
  tenant_id: string;
  customer_id: string;
  starts_at: Date | string;
  party_size: number | null;
  customer_name: string;
  customer_email: string | null;
  business_name: string;
  business_type: BusinessType;
  timezone: string;
  locale: string;
  settings: { emailConfirmations?: boolean; whatsappConfirmations?: boolean } | null;
  customer_phone: string | null;
  service_name: string | null;
  resource_name: string | null;
  address: string | null;
  phone: string | null;
  slug: string;
};

/** Addresses that never get mail (demo data and reserved test domains). */
export const isUndeliverable = (email: string) =>
  /@(example\.(com|org|net)|agenda\.mx)$/i.test(email) || /\.(test|invalid|example|localhost)$/i.test(email);

export const appUrl = () => (process.env.APP_URL ?? 'https://agenda-crm-rouge.vercel.app').replace(/\/$/, '');

async function load(appointmentId: string): Promise<Row | undefined> {
  const r = await getDb().execute<Row>(sql`
    select a.id, a.tenant_id, a.customer_id, a.starts_at, a.party_size, c.name as customer_name, c.email as customer_email, c.phone as customer_phone,
           t.name as business_name, t.business_type, t.timezone, t.locale, t.settings, t.slug,
           s.name as service_name, r.name as resource_name,
           coalesce(l.address, t.address) as address, coalesce(l.phone, t.phone) as phone
    from appointments a
    join tenants t on t.id = a.tenant_id
    join customers c on c.id = a.customer_id
    left join services s on s.id = a.service_id
    left join resources r on r.id = a.resource_id
    left join locations l on l.id = a.location_id
    where a.id = ${appointmentId}`);
  return r.rows[0];
}

const COPY = {
  es: {
    booked: (b: string, w: string) => `Tu ${w} en ${b} está confirmada`,
    rescheduled: (b: string, w: string) => `Cambió tu ${w} en ${b}`,
    cancelled: (b: string, w: string) => `Se canceló tu ${w} en ${b}`,
    reminder: (b: string, w: string) => `Recordatorio: tu ${w} en ${b}`,
    lead: {
      booked: 'Quedó agendada:',
      rescheduled: 'Tu nueva fecha es:',
      cancelled: 'Esta cita quedó cancelada:',
      reminder: 'Te esperamos:',
    },
    hello: (n: string) => `Hola ${n}:`,
    with: 'Con',
    people: (n: number) => `${n} personas`,
    where: 'Dónde',
    manage: 'Ver, cambiar o cancelar',
    portal: 'Ver todas mis citas',
    portalHealth: 'Mis citas, recetas y estudios',
    bookAgain: 'Reservar otra vez',
    footer: 'Este correo se envió automáticamente; para dudas contacta al negocio.',
    word: (k: string) => (k === 'appointments' ? 'cita' : 'reserva'),
    date: "cccc d 'de' LLLL 'a las' HH:mm",
  },
  en: {
    booked: (b: string, w: string) => `Your ${w} at ${b} is confirmed`,
    rescheduled: (b: string, w: string) => `Your ${w} at ${b} changed`,
    cancelled: (b: string, w: string) => `Your ${w} at ${b} was cancelled`,
    reminder: (b: string, w: string) => `Reminder: your ${w} at ${b}`,
    lead: {
      booked: "You're booked:",
      rescheduled: 'Your new date is:',
      cancelled: 'This booking was cancelled:',
      reminder: 'See you soon:',
    },
    hello: (n: string) => `Hi ${n},`,
    with: 'With',
    people: (n: number) => `${n} people`,
    where: 'Where',
    manage: 'View, change or cancel',
    portal: 'See all my appointments',
    portalHealth: 'My appointments, prescriptions and studies',
    bookAgain: 'Book again',
    footer: 'This email was sent automatically; contact the business with any questions.',
    word: (k: string) => (k === 'appointments' ? 'appointment' : 'booking'),
    date: "cccc, LLLL d 'at' h:mm a",
  },
};

/** Builds the email; exported for tests. */
export function appointmentEmail(r: Row, kind: AppointmentEmail) {
  const t = r.locale === 'en' ? COPY.en : COPY.es;
  const word = t.word(businessKind(r.business_type));
  const when = DateTime.fromJSDate(new Date(r.starts_at)).setZone(r.timezone).setLocale(r.locale === 'en' ? 'en' : 'es');
  const whenText = when.toFormat(t.date);
  const first = r.customer_name.split(' ')[0] ?? r.customer_name;
  const lines = [
    r.service_name,
    whenText.charAt(0).toUpperCase() + whenText.slice(1),
    r.resource_name ? `${t.with}: ${r.resource_name}` : null,
    r.party_size && r.party_size > 1 ? t.people(r.party_size) : null,
    r.address ? `${t.where}: ${r.address}` : null,
    r.phone ? `Tel. ${r.phone}` : null,
  ].filter((x): x is string => Boolean(x));
  const link = kind === 'cancelled' ? `${appUrl()}/b/${r.slug}` : `${appUrl()}/c/${manageToken(r.id)}`;
  const button = kind === 'cancelled' ? t.bookAgain : t.manage;
  const subject = t[kind](r.business_name, word);
  const portal = `${appUrl()}/p/${r.slug}?t=${portalToken(r.customer_id)}`;
  const portalText = isHealthType(r.business_type) ? t.portalHealth : t.portal;
  const text = [t.hello(first), '', t.lead[kind], ...lines, '', `${button}: ${link}`, `${portalText}: ${portal}`, '', `— ${r.business_name}`].join('\n');
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;max-width:520px">
<p>${escapeHtml(t.hello(first))}</p>
<p>${escapeHtml(t.lead[kind])}</p>
<div style="border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin:12px 0;${kind === 'cancelled' ? 'text-decoration:line-through;color:#64748b' : ''}">
${lines.map((l, i) => `<div style="${i < 2 ? 'font-weight:600;' : 'color:#475569;'}margin:2px 0">${escapeHtml(l)}</div>`).join('\n')}
</div>
<p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#0f766e;color:#fff;border-radius:8px;text-decoration:none">${escapeHtml(button)}</a></p>
<p><a href="${portal}" style="color:#0f766e">${escapeHtml(portalText)}</a></p>
<p style="color:#475569">${escapeHtml(r.business_name)}</p>
<p style="color:#94a3b8;font-size:12px">${escapeHtml(t.footer)}</p>
</div>`;
  return { subject, text, html };
}

/**
 * Sends one email about an appointment. Confirmations, changes and cancellations follow the
 * business's "emailConfirmations" setting (on by default); reminders follow "remindersEnabled".
 * Returns whether an email went out.
 */
export async function notifyAppointment(appointmentId: string, kind: AppointmentEmail): Promise<boolean> {
  try {
    const r = await load(appointmentId);
    if (!r) return false;
    if (kind === 'booked' || kind === 'rescheduled') await whatsappConfirmation(r);
    if (!r.customer_email || isUndeliverable(r.customer_email)) return false;
    if (kind !== 'reminder' && r.settings?.emailConfirmations === false) return false;
    const msg = appointmentEmail(r, kind);
    const ok = await sendEmail({ to: r.customer_email, ...msg });
    await getDb()
      .insert(messageLogs)
      .values({ tenantId: r.tenant_id, appointmentId: r.id, channel: 'email', template: kind, toPhone: r.customer_email, status: ok ? 'sent' : 'failed' })
      .catch(() => {});
    return ok;
  } catch (err) {
    console.error('[notify]', err);
    return false;
  }
}

/** WhatsApp confirmation (template with a button to the manage page), if the business turned it on. */
async function whatsappConfirmation(r: Row) {
  if (!r.customer_phone || !r.settings?.whatsappConfirmations || !isWhatsAppConfigured() || !whatsappAllowedFor(r.slug, r.customer_phone)) return;
  const start = DateTime.fromJSDate(new Date(r.starts_at)).setZone(r.timezone).setLocale(r.locale === 'en' ? 'en' : 'es');
  const tpl = WHATSAPP_TEMPLATES[1]!.name;
  const res = await sendTemplate({
    to: r.customer_phone,
    template: tpl,
    params: [r.customer_name.split(' ')[0] ?? r.customer_name, r.business_name, start.toFormat(r.locale === 'en' ? 'cccc, LLLL d' : "cccc d 'de' LLLL"), start.toFormat(r.locale === 'en' ? 'h:mm a' : 'HH:mm')],
    urlSuffix: manageToken(r.id),
  });
  if (res.status === 'failed') console.warn('[whatsapp] confirmation failed:', res.error);
  await getDb()
    .insert(messageLogs)
    .values({ tenantId: r.tenant_id, appointmentId: r.id, template: tpl, toPhone: r.customer_phone, status: res.status, providerMessageId: res.providerMessageId ?? null, error: res.error ?? null })
    .catch(() => {});
}
