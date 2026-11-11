/**
 * Transactional email through Resend's HTTP API (no SDK needed).
 * Env: RESEND_API_KEY and EMAIL_FROM (e.g. "Agenda <no-reply@tudominio.mx>"), only in Vercel.
 * Without a key nothing is sent; outside production the message is printed so it can be tested.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Messages "sent" while running the test suite. */
export const sentInTests: EmailMessage[] = [];

const isProduction = () => process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';

/** True when the message was handed to the provider (or recorded, in tests). */
export async function sendEmail(msg: EmailMessage): Promise<boolean> {
  if (process.env.NODE_ENV === 'test') {
    sentInTests.push(msg);
    return true;
  }
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) {
    // Never print reset links in production logs.
    if (isProduction()) console.warn(`[email] RESEND_API_KEY/EMAIL_FROM not set; "${msg.subject}" was not sent`);
    else console.info(`[email] (not sent, no provider) to=${msg.to} subject=${msg.subject}\n${msg.text}`);
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    });
    if (!res.ok) console.error(`[email] Resend error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.ok;
  } catch (err) {
    console.error('[email] Resend unreachable', err);
    return false;
  }
}

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
