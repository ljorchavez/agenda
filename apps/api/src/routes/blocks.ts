import { Hono } from 'hono';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { isManager, timeBlockInputSchema, type TimeBlockDto } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { timeBlocks, type TimeBlock } from '../db/schema.js';
import { getScope, type Scope } from '../lib/access.js';
import { AppError, notFound } from '../lib/errors.js';
import { resolveLocation } from '../lib/locations.js';
import { findResource } from '../lib/resources.js';
import type { AppEnv } from '../middleware/auth.js';

/**
 * Blocked times (holidays, vacations, a court under repair): nobody can book them online and
 * the team gets a 409 `blocked` / `resource_busy` unless they force it.
 * Owners/admins block anything in their reach; a team member linked to a resource blocks only it.
 */
export const blockRoutes = new Hono<AppEnv>();

const toDto = (b: TimeBlock): TimeBlockDto => ({
  id: b.id,
  startsAt: b.startsAt.toISOString(),
  endsAt: b.endsAt.toISOString(),
  locationId: b.locationId,
  resourceId: b.resourceId,
  reason: b.reason,
});

/** Who may create or remove this block. */
function assertCanTouch(scope: Scope, role: string, b: { locationId: string | null; resourceId: string | null }) {
  const forbidden = () => new AppError(403, 'forbidden', 'You cannot block this');
  if (!isManager(role as never)) {
    // Team members: only their own agenda.
    if (!scope.resourceId || b.resourceId !== scope.resourceId) throw forbidden();
    return;
  }
  // Location managers: only inside their location (never the whole business).
  if (scope.locationId && b.locationId !== scope.locationId) throw forbidden();
}

blockRoutes.get('/time-blocks', async (c) => {
  const from = new Date(c.req.query('from') ?? '');
  const to = new Date(c.req.query('to') ?? '');
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
    throw new AppError(422, 'validation_error', 'from/to required');
  }
  const db = getDb();
  const scope = await getScope(db, c);
  const rows = await db
    .select()
    .from(timeBlocks)
    .where(
      and(
        eq(timeBlocks.tenantId, c.get('tenantId')),
        lt(timeBlocks.startsAt, to),
        gt(timeBlocks.endsAt, from),
        // Location-limited logins see their location's blocks and the business-wide ones.
        scope.locationId ? sql`(${timeBlocks.locationId} is null or ${timeBlocks.locationId} = ${scope.locationId})` : undefined,
      ),
    )
    .orderBy(timeBlocks.startsAt)
    .limit(1000);
  return c.json(rows.map(toDto));
});

blockRoutes.post('/time-blocks', async (c) => {
  const input = timeBlockInputSchema.parse(await c.req.json());
  const tenantId = c.get('tenantId');
  const db = getDb();
  let locationId = input.locationId ?? null;
  const resourceId = input.resourceId ?? null;
  if (resourceId) locationId = (await findResource(db, tenantId, resourceId)).locationId;
  else if (locationId) locationId = (await resolveLocation(db, tenantId, locationId)).id;
  assertCanTouch(await getScope(db, c), c.get('role'), { locationId, resourceId });
  const [row] = await db
    .insert(timeBlocks)
    .values({
      tenantId,
      locationId,
      resourceId,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      reason: input.reason || null,
    })
    .returning();
  return c.json(toDto(row!), 201);
});

blockRoutes.delete('/time-blocks/:id', async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const row = await db.query.timeBlocks.findFirst({ where: and(eq(timeBlocks.id, c.req.param('id')), eq(timeBlocks.tenantId, tenantId)) });
  if (!row) throw notFound('time block');
  assertCanTouch(await getScope(db, c), c.get('role'), row);
  await db.delete(timeBlocks).where(and(eq(timeBlocks.id, row.id), eq(timeBlocks.tenantId, tenantId)));
  return c.body(null, 204);
});
