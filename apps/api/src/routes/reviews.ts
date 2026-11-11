import { Hono } from 'hono';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  MIN_PUBLIC_REVIEWS,
  reviewsArePublic,
  reviewInputSchema,
  reviewModerationSchema,
  type PublicReviewDto,
  type ReviewDto,
  type ReviewRequestDto,
  type ReviewSummaryDto,
} from '@agenda/shared';
import { getDb, type Db } from '../db/client.js';
import { appointments, customers, reviews, services, tenants } from '../db/schema.js';
import { verifyManageToken } from '../lib/crypto.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { guardRow } from '../lib/locations.js';
import { requireManager, type AppEnv } from '../middleware/auth.js';

/**
 * Verified reviews: only a customer with a completed booking can leave one, through that booking's
 * private link (/r/<token>, the same signed token as "gestionar mi cita"). One per booking.
 * The business can reply in public and hide offensive ones, but never edit them.
 */
export const publicReviewRoutes = new Hono();
export const reviewRoutes = new Hono<AppEnv>();

/** "María G." */
export const shortName = (full: string) => {
  const [first = '', last = ''] = full.trim().split(/\s+/);
  return last ? `${first} ${last[0]!.toUpperCase()}.` : first;
};

const toPublic = (r: typeof reviews.$inferSelect): PublicReviewDto => ({
  authorName: r.authorName,
  rating: r.rating,
  comment: r.comment,
  reply: r.reply,
  createdAt: r.createdAt.toISOString(),
});

/** Average, count and the latest visible reviews of a business (or one location). */
/** What the public sees: nothing when the business turned reviews off or has fewer than 3. */
export async function publicReviewSummary(db: Pick<Db, 'execute' | 'select'>, tenant: { id: string; settings: { reviews?: { public?: boolean } } }, recent = 5): Promise<ReviewSummaryDto> {
  if (!reviewsArePublic(tenant.settings)) return { average: null, count: 0, recent: [] };
  const s = await reviewSummary(db, tenant.id, recent);
  return s.count >= MIN_PUBLIC_REVIEWS ? s : { average: null, count: 0, recent: [] };
}

export async function reviewSummary(db: Pick<Db, 'execute' | 'select'>, tenantId: string, recent = 5, locationId?: string): Promise<ReviewSummaryDto> {
  const where = and(eq(reviews.tenantId, tenantId), eq(reviews.hidden, false), locationId ? eq(reviews.locationId, locationId) : undefined);
  const [agg] = await db.select({ avg: sql<string | null>`avg(${reviews.rating})`, n: sql<string>`count(*)` }).from(reviews).where(where);
  const rows = recent ? await db.select().from(reviews).where(where).orderBy(desc(reviews.createdAt)).limit(recent) : [];
  const count = Number(agg?.n ?? 0);
  return { average: count ? Math.round(Number(agg!.avg) * 10) / 10 : null, count, recent: rows.map(toPublic) };
}

async function loadByToken(token: string) {
  const id = verifyManageToken(token);
  if (!id) throw notFound('booking');
  const db = getDb();
  const a = await db.query.appointments.findFirst({ where: eq(appointments.id, id) });
  if (!a) throw notFound('booking');
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, a.tenantId) });
  const s = await db.query.services.findFirst({ where: eq(services.id, a.serviceId) });
  const existing = await db.query.reviews.findFirst({ where: eq(reviews.appointmentId, a.id) });
  return { a, t: t!, s, existing };
}

publicReviewRoutes.get('/public/reviews/:token', async (c) => {
  const { a, t, s, existing } = await loadByToken(c.req.param('token'));
  const body: ReviewRequestDto = {
    businessName: t.name,
    serviceName: s?.name ?? '',
    startsAt: a.startsAt.toISOString(),
    review: existing ? toPublic(existing) : null,
    notYet: a.status !== 'completed',
  };
  return c.json(body);
});

publicReviewRoutes.post('/public/reviews/:token', async (c) => {
  const input = reviewInputSchema.parse(await c.req.json());
  const { a, existing } = await loadByToken(c.req.param('token'));
  if (a.status !== 'completed') throw new AppError(422, 'review_not_yet', 'You can review once the visit is completed');
  if (existing) throw conflict('already_reviewed', 'This visit already has a review');
  const db = getDb();
  const cu = await db.query.customers.findFirst({ where: eq(customers.id, a.customerId) });
  const [row] = await db
    .insert(reviews)
    .values({
      tenantId: a.tenantId, appointmentId: a.id, customerId: a.customerId, locationId: a.locationId,
      authorName: shortName(cu?.name ?? ''), rating: input.rating, comment: input.comment || null,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict('already_reviewed', 'This visit already has a review');
  return c.json(toPublic(row), 201);
});

reviewRoutes.get('/reviews', async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const own = c.get('role') === 'owner' ? null : c.get('locationId');
  const res = await db.execute<{
    id: string; appointment_id: string; author_name: string; rating: number; comment: string | null; reply: string | null;
    replied_at: Date | null; hidden: boolean; service_name: string | null; location_name: string | null; created_at: Date;
  }>(sql`
    select r.*, s.name as service_name, l.name as location_name
    from reviews r
    left join appointments a on a.id = r.appointment_id
    left join services s on s.id = a.service_id
    left join locations l on l.id = r.location_id
    where r.tenant_id = ${tenantId} ${own ? sql`and r.location_id = ${own}` : sql``}
    order by r.created_at desc limit 500`);
  const out: ReviewDto[] = res.rows.map((r) => ({
    id: r.id,
    appointmentId: r.appointment_id,
    authorName: r.author_name,
    rating: r.rating,
    comment: r.comment,
    reply: r.reply,
    repliedAt: r.replied_at ? new Date(r.replied_at).toISOString() : null,
    hidden: r.hidden,
    serviceName: r.service_name,
    locationName: r.location_name,
    createdAt: new Date(r.created_at).toISOString(),
  }));
  const summary = await reviewSummary(db, tenantId, 0, own ?? undefined);
  return c.json({ items: out, average: summary.average, count: summary.count });
});

/** Reply in public and/or hide; the customer's words are never edited. */
reviewRoutes.patch('/reviews/:id', requireManager, async (c) => {
  const input = reviewModerationSchema.parse(await c.req.json());
  const db = getDb();
  const r = await db.query.reviews.findFirst({ where: and(eq(reviews.id, c.req.param('id')), eq(reviews.tenantId, c.get('tenantId'))) });
  if (!r) throw notFound('review');
  if (r.locationId) guardRow(c, r.locationId);
  await db
    .update(reviews)
    .set({
      ...(input.reply !== undefined ? { reply: input.reply || null, repliedAt: input.reply ? new Date() : null } : {}),
      ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
    })
    .where(eq(reviews.id, r.id));
  return c.json({ ok: true });
});
