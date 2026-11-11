import { Hono } from 'hono';
import { and, asc, eq } from 'drizzle-orm';
import { formAnswersSchema, formInputSchema, type AppointmentFormDto } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { appointments, forms, services, users } from '../db/schema.js';
import { getScope, inScope, forbiddenScope } from '../lib/access.js';
import { AppError, notFound } from '../lib/errors.js';
import { formsForService, listResponses, responseCounts, saveResponse, toFormDto, toPublicForm } from '../lib/forms.js';
import { assertFeature } from '../lib/plan.js';
import { requireBusinessManager, type AppEnv } from '../middleware/auth.js';
import { assertAccess } from './records.js';

/**
 * Questionnaires per booking type: the business builds forms (reusable across several services),
 * the customer answers them when booking online or the team fills them in the booking. Answers are
 * part of the client record: encrypted and with the same access rules.
 */
export const formRoutes = new Hono<AppEnv>();

formRoutes.get('/forms', async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  await assertFeature(db, tenantId, 'records');
  const rows = await db.select().from(forms).where(eq(forms.tenantId, tenantId)).orderBy(asc(forms.name));
  const counts = await responseCounts(db, tenantId);
  return c.json(rows.map((f) => toFormDto(f, counts.get(f.id) ?? 0)));
});

const validServices = async (tenantId: string, ids: string[]) => {
  if (!ids.length) return [];
  const own = await getDb().select({ id: services.id }).from(services).where(eq(services.tenantId, tenantId));
  const set = new Set(own.map((s) => s.id));
  return [...new Set(ids)].filter((id) => set.has(id));
};

formRoutes.post('/forms', requireBusinessManager, async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  await assertFeature(db, tenantId, 'records');
  const input = formInputSchema.parse(await c.req.json());
  const [row] = await db
    .insert(forms)
    .values({ tenantId, name: input.name, description: input.description ?? null, fields: input.fields, serviceIds: await validServices(tenantId, input.serviceIds), askOnline: input.askOnline, active: input.active })
    .returning();
  return c.json(toFormDto(row!, 0), 201);
});

formRoutes.put('/forms/:id', requireBusinessManager, async (c) => {
  const db = getDb();
  const tenantId = c.get('tenantId');
  await assertFeature(db, tenantId, 'records');
  const input = formInputSchema.parse(await c.req.json());
  const [row] = await db
    .update(forms)
    .set({ name: input.name, description: input.description ?? null, fields: input.fields, serviceIds: await validServices(tenantId, input.serviceIds), askOnline: input.askOnline, active: input.active, updatedAt: new Date() })
    .where(and(eq(forms.id, c.req.param('id')), eq(forms.tenantId, tenantId)))
    .returning();
  if (!row) throw notFound('form');
  const counts = await responseCounts(db, tenantId);
  return c.json(toFormDto(row, counts.get(row.id) ?? 0));
});

/** Deleting a form keeps the answers already saved in the records (they have their own copy). */
formRoutes.delete('/forms/:id', requireBusinessManager, async (c) => {
  const res = await getDb().delete(forms).where(and(eq(forms.id, c.req.param('id')), eq(forms.tenantId, c.get('tenantId')))).returning({ id: forms.id });
  if (!res.length) throw notFound('form');
  return c.body(null, 204);
});

const apptFor = async (c: Parameters<typeof assertAccess>[0], id: string) => {
  const db = getDb();
  const a = await db.query.appointments.findFirst({ where: and(eq(appointments.id, id), eq(appointments.tenantId, c.get('tenantId'))) });
  if (!a) throw notFound('appointment');
  const scope = await getScope(db, c);
  if (!inScope(scope, a)) throw forbiddenScope();
  await assertAccess(c, a.customerId);
  return a;
};

/** The questionnaires of a booking's service, answered or not. */
formRoutes.get('/appointments/:id/forms', async (c) => {
  const a = await apptFor(c, c.req.param('id'));
  const db = getDb();
  const tenantId = c.get('tenantId');
  const list = await formsForService(db, tenantId, a.serviceId);
  const answered = await listResponses(db, tenantId, { appointmentId: a.id });
  const body: AppointmentFormDto[] = list.map((f) => ({ form: toPublicForm(f), response: answered.find((r) => r.formId === f.id) ?? null }));
  // Answers to forms no longer attached to this service still show
  for (const r of answered) if (!list.some((f) => f.id === r.formId)) body.push({ form: { id: r.formId ?? r.id, name: r.formName, description: null, fields: [], serviceIds: [] }, response: r });
  c.header('Cache-Control', 'private, no-store');
  return c.json(body);
});

/** The team fills (or corrects) a questionnaire for a booking. */
formRoutes.post('/appointments/:id/forms', async (c) => {
  const a = await apptFor(c, c.req.param('id'));
  const input = formAnswersSchema.parse(await c.req.json());
  const db = getDb();
  const tenantId = c.get('tenantId');
  const f = await db.query.forms.findFirst({ where: and(eq(forms.id, input.formId), eq(forms.tenantId, tenantId)) });
  if (!f) throw notFound('form');
  if (!f.fields.length) throw new AppError(422, 'form_invalid', 'Empty form');
  const userId = c.get('userId');
  const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { name: true } });
  const id = await saveResponse(db, { tenantId, customerId: a.customerId, appointmentId: a.id, form: f, values: input.values, source: 'staff', authorId: userId, authorName: u?.name ?? null });
  const [saved] = (await listResponses(db, tenantId, { appointmentId: a.id })).filter((r) => r.id === id);
  return c.json(saved, 201);
});
