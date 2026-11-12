import crypto from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { escapeHtml, sendEmail } from './email.js';

/**
 * Error monitoring without a third-party service: unexpected API errors and browser errors are
 * grouped by fingerprint in `error_events`, and the first time one appears (or again after an
 * hour) an email goes to ALERT_EMAIL. Never throws: monitoring must not break a request.
 */
export interface ErrorReport {
  source: 'api' | 'web';
  message: string;
  stack?: string | null;
  path?: string | null;
  userAgent?: string | null;
  tenantId?: string | null;
}

const ALERT_EVERY_MS = 60 * 60 * 1000;
/** At most this many alert emails a day, whatever happens. */
const DAILY_ALERT_CAP = 40;

/** Same bug, same fingerprint: message without numbers/ids plus the first stack frame. */
export function fingerprint(r: ErrorReport): string {
  const msg = r.message.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>').replace(/\d+/g, '<n>').slice(0, 300);
  const frame = (r.stack ?? '').split('\n').find((l) => /\s+at\s|@/.test(l))?.trim().replace(/:\d+:\d+/g, '') ?? '';
  return crypto.createHash('sha1').update(`${r.source}|${msg}|${frame}`).digest('hex');
}

/** Browser noise that says nothing about our app. */
export function isNoise(r: ErrorReport): boolean {
  const m = r.message;
  return (
    /_leaflet_pos|ResizeObserver loop|Script error\.?$|Non-Error promise rejection captured|Load failed|Failed to fetch|NetworkError|AbortError|The operation was aborted/i.test(m) ||
    /chrome-extension:|moz-extension:|safari-extension:/i.test(r.stack ?? '')
  );
}

export async function recordError(r: ErrorReport): Promise<void> {
  if (process.env.NODE_ENV === 'test' && !process.env.TEST_MONITOR) return;
  try {
    if (r.source === 'web' && isNoise(r)) return;
    const fp = fingerprint(r);
    const db = getDb();
    const res = await db.execute<{ count: number; last_alerted_at: string | null; first: boolean }>(sql`
      insert into error_events (fingerprint, source, message, stack, path, user_agent, tenant_id)
      values (${fp}, ${r.source}, ${r.message.slice(0, 1000)}, ${r.stack?.slice(0, 8000) ?? null},
              ${r.path?.slice(0, 500) ?? null}, ${r.userAgent?.slice(0, 300) ?? null}, ${r.tenantId ?? null})
      on conflict (fingerprint) do update set count = error_events.count + 1, last_seen = now(),
        path = excluded.path, stack = coalesce(excluded.stack, error_events.stack)
      returning count, last_alerted_at, (xmax = 0) as first`);
    const row = res.rows[0];
    if (!row) return;
    const last = row.last_alerted_at ? new Date(row.last_alerted_at).getTime() : 0;
    if (Date.now() - last < ALERT_EVERY_MS) return;
    const today = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from error_events where last_alerted_at > now() - interval '1 day'`);
    if ((today.rows[0]?.n ?? 0) >= DAILY_ALERT_CAP) return;
    // Claim the alert first so concurrent errors don't send it twice.
    const claimed = await db.execute(sql`update error_events set last_alerted_at = now()
      where fingerprint = ${fp} and (last_alerted_at is null or last_alerted_at < now() - interval '1 hour') returning id`);
    if (!claimed.rows.length) return;
    await alert(r, Number(row.count), Boolean(row.first));
  } catch (e) {
    console.error('[monitor] could not record error:', e);
  }
}

async function alert(r: ErrorReport, count: number, first: boolean) {
  const to = process.env.ALERT_EMAIL?.trim();
  if (!to) return;
  const where = r.source === 'api' ? 'servidor' : 'navegador';
  const subject = `[Lugali] ${first ? 'Error nuevo' : `Error repetido (${count} veces)`} en ${where}: ${r.message.slice(0, 80)}`;
  const lines = [
    `Origen: ${where}`,
    `Ruta: ${r.path ?? '-'}`,
    `Veces: ${count}`,
    r.tenantId ? `Negocio: ${r.tenantId}` : null,
    r.userAgent ? `Navegador: ${r.userAgent}` : null,
    '',
    r.message,
    '',
    (r.stack ?? '').slice(0, 3000),
  ].filter((l) => l !== null);
  await sendEmail({
    to,
    subject,
    text: lines.join('\n'),
    html: `<pre style="font-family:ui-monospace,monospace;font-size:12px;white-space:pre-wrap">${escapeHtml(lines.join('\n'))}</pre>`,
  });
}
