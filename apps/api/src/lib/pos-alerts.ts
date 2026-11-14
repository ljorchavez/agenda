/**
 * Things worth a look in the point of sale, from the last 30 days. Plain rules over the data
 * (no AI): cash closings that didn't match, days left without a closing, sales charged below the
 * catalogue price or below cost, stock that went out without a sale, and unusual cancellations.
 */
import { sql } from 'drizzle-orm';
import { DateTime } from 'luxon';
import type { PosAlertDto } from '@agenda/shared';
import type { Db } from '../db/client.js';

const DAYS = 30;

export async function posAlerts(db: Db, tenantId: string, tz: string, locationId: string | null): Promise<PosAlertDto[]> {
  const since = DateTime.now().setZone(tz).minus({ days: DAYS }).startOf('day');
  const sinceDate = since.toJSDate();
  const sinceDay = since.toISODate()!;
  const today = DateTime.now().setZone(tz).toISODate()!;
  const loc = (col: string) => (locationId ? sql`and ${sql.raw(col)} = ${locationId}` : sql``);
  const out: PosAlertDto[] = [];

  // 1. Closings where the counted cash didn't match
  const diffs = await db.execute<{ day: string; diff: string; by: string | null; notes: string | null }>(sql`
    select day::text as day, (counted_cash_cents - expected_cash_cents) as diff, closed_by_name as by, notes
    from cash_closings
    where tenant_id = ${tenantId} and day >= ${sinceDay} and counted_cash_cents <> expected_cash_cents ${loc('location_id')}
    order by day desc`);
  if (diffs.rows.length) {
    const short = diffs.rows.filter((r) => Number(r.diff) < 0);
    const shortCents = -short.reduce((a, r) => a + Number(r.diff), 0);
    out.push({
      kind: 'cash_diff',
      severity: shortCents >= 50000 || short.length >= 4 ? 'high' : 'medium',
      count: diffs.rows.length,
      amountCents: shortCents,
      items: diffs.rows.slice(0, 6).map((r) => ({ label: r.day, amountCents: Number(r.diff), note: [r.by, r.notes].filter(Boolean).join(' · ') || null })),
    });
  }

  // 2. Days with sales and no closing (before today)
  const open = await db.execute<{ day: string; total: string }>(sql`
    select (s.created_at at time zone ${tz})::date::text as day, sum(s.total_cents) as total
    from sales s
    where s.tenant_id = ${tenantId} and s.status = 'paid' and s.created_at >= ${sinceDate} ${loc('s.location_id')}
      and (s.created_at at time zone ${tz})::date < ${today}::date
      and not exists (select 1 from cash_closings cc where cc.tenant_id = s.tenant_id and cc.location_id = s.location_id
                      and cc.day = (s.created_at at time zone ${tz})::date)
    group by 1 order by 1 desc`);
  if (open.rows.length) {
    out.push({
      kind: 'no_closing',
      severity: open.rows.length >= 3 ? 'high' : 'medium',
      count: open.rows.length,
      amountCents: open.rows.reduce((a, r) => a + Number(r.total), 0),
      items: open.rows.slice(0, 6).map((r) => ({ label: r.day, amountCents: Number(r.total), note: null })),
    });
  }

  // 3. Lines charged well below the catalogue price, and lines below cost
  const lines = await db.execute<{ by: string | null; n: string; given: string; below_cost: string; loss: string }>(sql`
    select s.created_by_name as by,
           count(*) filter (where (i->>'unitCents')::int < p.price_cents * 0.9) as n,
           coalesce(sum((p.price_cents - (i->>'unitCents')::int) * (i->>'qty')::int) filter (where (i->>'unitCents')::int < p.price_cents * 0.9), 0) as given,
           count(*) filter (where p.cost_cents is not null and (i->>'unitCents')::int < p.cost_cents) as below_cost,
           coalesce(sum((p.cost_cents - (i->>'unitCents')::int) * (i->>'qty')::int) filter (where p.cost_cents is not null and (i->>'unitCents')::int < p.cost_cents), 0) as loss
    from sales s
    cross join lateral jsonb_array_elements(s.items) i
    join products p on p.id = (i->>'productId')::uuid
    where s.tenant_id = ${tenantId} and s.status = 'paid' and s.created_at >= ${sinceDate} ${loc('s.location_id')}
      and i->>'productId' is not null
    group by 1`);
  const disc = lines.rows.filter((r) => Number(r.n) > 0);
  if (disc.length) {
    const total = disc.reduce((a, r) => a + Number(r.given), 0);
    out.push({
      kind: 'discounts',
      severity: total >= 100000 ? 'high' : 'low',
      count: disc.reduce((a, r) => a + Number(r.n), 0),
      amountCents: total,
      items: disc.sort((a, b) => Number(b.given) - Number(a.given)).slice(0, 6).map((r) => ({ label: r.by ?? '—', amountCents: Number(r.given), note: String(r.n) })),
    });
  }
  const cost = lines.rows.filter((r) => Number(r.below_cost) > 0);
  if (cost.length) {
    out.push({
      kind: 'below_cost',
      severity: 'high',
      count: cost.reduce((a, r) => a + Number(r.below_cost), 0),
      amountCents: cost.reduce((a, r) => a + Number(r.loss), 0),
      items: cost.slice(0, 6).map((r) => ({ label: r.by ?? '—', amountCents: Number(r.loss), note: String(r.below_cost) })),
    });
  }

  // 4. Stock taken out by hand (counts that came out short), valued at cost
  const shrink = await db.execute<{ name: string; units: string; value: string }>(sql`
    select p.name, -sum(m.qty_change) as units, -sum(m.qty_change * coalesce(p.cost_cents, p.price_cents)) as value
    from stock_moves m join products p on p.id = m.product_id
    where m.tenant_id = ${tenantId} and m.reason = 'adjust' and m.qty_change < 0 and m.created_at >= ${sinceDate} ${loc('m.location_id')}
    group by p.name order by 3 desc`);
  if (shrink.rows.length) {
    const value = shrink.rows.reduce((a, r) => a + Number(r.value), 0);
    out.push({
      kind: 'shrinkage',
      severity: value >= 100000 ? 'high' : 'medium',
      count: shrink.rows.reduce((a, r) => a + Number(r.units), 0),
      amountCents: value,
      items: shrink.rows.slice(0, 6).map((r) => ({ label: r.name, amountCents: Number(r.value), note: String(r.units) })),
    });
  }

  // 5. Who sells and later cancels much more than the rest (3+ cancellations, over twice the usual rate)
  const cancels = await db.execute<{ by: string | null; total: string; canceled: string; amount: string }>(sql`
    select created_by_name as by, count(*) as total, count(*) filter (where status = 'canceled') as canceled,
           coalesce(sum(total_cents) filter (where status = 'canceled'), 0) as amount
    from sales where tenant_id = ${tenantId} and created_at >= ${sinceDate} ${loc('location_id')}
    group by 1`);
  const all = cancels.rows.reduce((a, r) => a + Number(r.total), 0);
  const allCanceled = cancels.rows.reduce((a, r) => a + Number(r.canceled), 0);
  const rate = all ? allCanceled / all : 0;
  const odd = cancels.rows.filter((r) => Number(r.canceled) >= 3 && Number(r.canceled) / Number(r.total) > Math.max(2 * rate, 0.03));
  if (odd.length) {
    out.push({
      kind: 'cancellations',
      severity: 'medium',
      count: odd.reduce((a, r) => a + Number(r.canceled), 0),
      amountCents: odd.reduce((a, r) => a + Number(r.amount), 0),
      items: odd.map((r) => ({ label: r.by ?? '—', amountCents: Number(r.amount), note: `${r.canceled}/${r.total}` })),
    });
  }

  const rank = { high: 0, medium: 1, low: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
