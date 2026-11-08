import { sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { getDb } from '../db/client.js';
import { messageLogs } from '../db/schema.js';
import { sendReminder } from '../integrations/whatsapp.js';

type DueRow = {
  id: string;
  tenant_id: string;
  starts_at: Date;
  customer_name: string;
  customer_phone: string;
  business_name: string;
  timezone: string;
  locale: string;
};

/**
 * Sends WhatsApp reminders for appointments starting within each tenant's
 * `reminderHoursBefore` window. Runs every 15 minutes (EventBridge in AWS).
 *
 * Rows are claimed atomically (UPDATE ... FOR UPDATE SKIP LOCKED) so two concurrent
 * runs never send the same reminder twice.
 */
export async function sendDueReminders(
  limit = 200,
  /** Minimum look-ahead window in hours (useful when the job runs only once a day). */
  lookaheadHours = Number(process.env.REMINDER_LOOKAHEAD_HOURS ?? 0),
): Promise<{ processed: number; sent: number }> {
  const db = getDb();
  const due = await db.execute<DueRow>(sql`
    with due as (
      select a.id from appointments a
      join tenants t on t.id = a.tenant_id
      join customers c on c.id = a.customer_id
      where a.status in ('scheduled', 'confirmed')
        and a.reminder_sent_at is null
        and c.phone is not null
        and (t.settings->>'remindersEnabled')::boolean = true
        and a.starts_at > now()
        and a.starts_at <= now() + (greatest((t.settings->>'reminderHoursBefore')::int, ${lookaheadHours}::int) * interval '1 hour')
      order by a.starts_at
      limit ${limit}
      for update of a skip locked
    )
    update appointments a set reminder_sent_at = now()
    from due, customers c, tenants t
    where a.id = due.id and c.id = a.customer_id and t.id = a.tenant_id
    returning a.id, a.tenant_id, a.starts_at, c.name as customer_name, c.phone as customer_phone,
              t.name as business_name, t.timezone, t.locale`);

  let sent = 0;
  for (const r of due.rows) {
    const start = DateTime.fromJSDate(new Date(r.starts_at)).setZone(r.timezone).setLocale(r.locale);
    const result = await sendReminder({
      to: r.customer_phone,
      customerName: r.customer_name.split(' ')[0] ?? r.customer_name,
      businessName: r.business_name,
      date: start.toFormat(r.locale === 'en' ? 'cccc, LLLL d' : "cccc d 'de' LLLL"),
      time: start.toFormat(r.locale === 'en' ? 'h:mm a' : 'HH:mm'),
      appointmentId: r.id,
    });
    if (result.status !== 'failed') sent++;
    await db.insert(messageLogs).values({
      tenantId: r.tenant_id,
      appointmentId: r.id,
      template: process.env.WHATSAPP_REMINDER_TEMPLATE ?? 'appointment_reminder',
      toPhone: r.customer_phone,
      status: result.status,
      providerMessageId: result.providerMessageId ?? null,
      error: result.error ?? null,
    });
    // On failure, re-arm so the next run retries.
    if (result.status === 'failed') {
      await db.execute(sql`update appointments set reminder_sent_at = null where id = ${r.id}`);
    }
  }
  return { processed: due.rows.length, sent };
}
