import { randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { calendarFeedTargetSchema, type CalendarFeedDto } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { calendarFeeds, locations, resources, tenants } from '../db/schema.js';
import { getScope } from '../lib/access.js';
import { AppError, notFound } from '../lib/errors.js';
import type { AppEnv } from '../middleware/auth.js';

/**
 * One-way calendar subscription (iCal) for Google Calendar / iPhone: a secret link per business,
 * per location and per team member. Regenerating a link invalidates the old one.
 * Events carry only the service, the customer's first name and the location: no phones or notes.
 */
export const publicCalendarRoutes = new Hono();
export const calendarRoutes = new Hono<AppEnv>();

type Target = { scope: 'business' | 'location' | 'resource'; locationId: string | null; resourceId: string | null };
const newToken = () => randomBytes(24).toString('base64url');
const origin = (c: Context) => process.env.APP_URL?.replace(/\/$/, '') ?? new URL(c.req.url).origin;

/** Links this login may use: owners/admins all; gerentes their location and its team; staff their own. */
async function allowedTargets(c: Context<AppEnv>): Promise<(Target & { label: string })[]> {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const scope = await getScope(db, c);
  const role = c.get('role');
  if (scope.personal) {
    if (!scope.resourceId) return [];
    const r = await db.query.resources.findFirst({ where: eq(resources.id, scope.resourceId) });
    return r ? [{ scope: 'resource', locationId: null, resourceId: r.id, label: r.name }] : [];
  }
  if (role === 'staff') return [];
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  const locs = await db.select().from(locations).where(and(eq(locations.tenantId, tenantId), eq(locations.active, true)));
  const res = await db.select().from(resources).where(and(eq(resources.tenantId, tenantId), eq(resources.active, true)));
  const own = scope.locationId;
  const out: (Target & { label: string })[] = [];
  if (!own) out.push({ scope: 'business', locationId: null, resourceId: null, label: t!.name });
  if (locs.length > 1) for (const l of locs) if (!own || l.id === own) out.push({ scope: 'location', locationId: l.id, resourceId: null, label: l.name });
  for (const r of res) if (!own || r.locationId === own) out.push({ scope: 'resource', locationId: null, resourceId: r.id, label: r.name });
  return out;
}

const sameTarget = (a: Target, b: Target) => a.scope === b.scope && (a.locationId ?? null) === (b.locationId ?? null) && (a.resourceId ?? null) === (b.resourceId ?? null);

async function tokenFor(tenantId: string, t: Target, regenerate = false): Promise<string> {
  const db = getDb();
  const where = and(
    eq(calendarFeeds.tenantId, tenantId),
    eq(calendarFeeds.scope, t.scope),
    t.locationId ? eq(calendarFeeds.locationId, t.locationId) : isNull(calendarFeeds.locationId),
    t.resourceId ? eq(calendarFeeds.resourceId, t.resourceId) : isNull(calendarFeeds.resourceId),
  );
  const existing = await db.query.calendarFeeds.findFirst({ where });
  if (existing && !regenerate) return existing.token;
  const token = newToken();
  if (existing) await db.update(calendarFeeds).set({ token, createdAt: new Date() }).where(eq(calendarFeeds.id, existing.id));
  else await db.insert(calendarFeeds).values({ tenantId, token, scope: t.scope, locationId: t.locationId, resourceId: t.resourceId });
  return token;
}

calendarRoutes.get('/calendar-feeds', async (c) => {
  const targets = await allowedTargets(c);
  const out: CalendarFeedDto[] = [];
  for (const t of targets) out.push({ ...t, url: `${origin(c)}/api/ical/${await tokenFor(c.get('tenantId'), t)}.ics` });
  return c.json(out);
});

calendarRoutes.post('/calendar-feeds/regenerate', async (c) => {
  const input = calendarFeedTargetSchema.parse(await c.req.json());
  const target: Target = { scope: input.scope, locationId: input.locationId ?? null, resourceId: input.resourceId ?? null };
  const allowed = (await allowedTargets(c)).find((t) => sameTarget(t, target));
  if (!allowed) throw new AppError(403, 'forbidden', 'Not your calendar');
  const token = await tokenFor(c.get('tenantId'), target, true);
  return c.json({ ...allowed, url: `${origin(c)}/api/ical/${token}.ics` });
});

// ---------- The .ics itself (public, secret URL) ----------

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
/** Lines longer than 75 octets are folded (RFC 5545). */
const fold = (line: string) => {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 74) {
    let cut = 74;
    while (Buffer.byteLength(rest.slice(0, cut)) > 74) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
};

publicCalendarRoutes.get('/ical/:file', async (c) => {
  const token = c.req.param('file').replace(/\.ics$/, '');
  const db = getDb();
  const feed = await db.query.calendarFeeds.findFirst({ where: eq(calendarFeeds.token, token) });
  if (!feed) throw notFound('calendar');
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, feed.tenantId) });
  const res = await db.execute<{ id: string; starts_at: Date; ends_at: Date; status: string; service: string; customer: string; location: string; resource: string | null }>(sql`
    select a.id, a.starts_at, a.ends_at, a.status, s.name as service, cu.name as customer, l.name as location, r.name as resource
    from appointments a
    join services s on s.id = a.service_id
    join customers cu on cu.id = a.customer_id
    join locations l on l.id = a.location_id
    left join class_sessions cs on cs.id = a.class_session_id
    left join resources r on r.id = coalesce(a.resource_id, cs.resource_id)
    where a.tenant_id = ${feed.tenantId} and a.status <> 'cancelled'
      and a.starts_at >= now() - interval '30 days' and a.starts_at <= now() + interval '180 days'
      ${feed.scope === 'location' ? sql`and a.location_id = ${feed.locationId}` : sql``}
      ${feed.scope === 'resource' ? sql`and coalesce(a.resource_id, cs.resource_id) = ${feed.resourceId}` : sql``}
    order by a.starts_at limit 3000`);
  const now = stamp(new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Agenda//Reservas//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(t?.name ?? 'Agenda')}`,
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const r of res.rows) {
    const first = r.customer.trim().split(/\s+/)[0] ?? '';
    lines.push(
      'BEGIN:VEVENT',
      `UID:${r.id}@agenda`,
      `DTSTAMP:${now}`,
      `DTSTART:${stamp(new Date(r.starts_at))}`,
      `DTEND:${stamp(new Date(r.ends_at))}`,
      `SUMMARY:${esc(`${r.service} · ${first}`)}`,
      `LOCATION:${esc(r.location)}`,
      ...(r.resource && feed.scope !== 'resource' ? [`DESCRIPTION:${esc(r.resource)}`] : []),
      `STATUS:${r.status === 'scheduled' ? 'TENTATIVE' : 'CONFIRMED'}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.map(fold).join('\r\n') + '\r\n', {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=300' },
  });
});
