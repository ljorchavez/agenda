import { randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { del, put } from '@vercel/blob';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  RECORD_PHOTO_MAX_BYTES,
  recordNoteSchema,
  recordUpdateSchema,
  type CustomerRecordDto,
} from '@agenda/shared';
import { getDb } from '../db/client.js';
import { customerRecords, customers, recordNotes, recordPhotos, users } from '../db/schema.js';
import { getScope, scopeSql } from '../lib/access.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import { assertFeature, assertPhotoRoom } from '../lib/plan.js';
import { listResponses } from '../lib/forms.js';
import type { AppEnv } from '../middleware/auth.js';

/**
 * Client record (expediente): allergies, conditions/medication, dated notes with their author and
 * before/after photos. Sensitive personal data (LFPDPPP):
 * - text is encrypted in the database (lib/crypto);
 * - only owners, admins and the team member who attended the customer can see it;
 * - photos live in a PRIVATE Blob store and are only served through this API, after the same check.
 * Env: EXPEDIENTES_READ_WRITE_TOKEN (private Blob store "agenda-expedientes", prefix EXPEDIENTES).
 */
export const recordRoutes = new Hono<AppEnv>();

export const photoToken = () => process.env.EXPEDIENTES_READ_WRITE_TOKEN;
const enc = (v: string | null | undefined) => (v ? encryptSecret(v) : null);
const dec = (v: string | null) => {
  if (!v) return null;
  try {
    return decryptSecret(v);
  } catch {
    return null;
  }
};
const TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** Owners and admins; team members only for customers they attended. 404 otherwise. */
export async function assertAccess(c: Context<AppEnv>, customerId: string) {
  const db = getDb();
  const tenantId = c.get('tenantId');
  const cu = await db.query.customers.findFirst({ where: and(eq(customers.id, customerId), eq(customers.tenantId, tenantId)) });
  if (!cu) throw notFound('customer');
  await assertFeature(db, tenantId, 'records');
  const role = c.get('role');
  if (role === 'owner' || role === 'admin') return cu;
  const scope = await getScope(db, c);
  if (scope.personal) {
    const res = await db.execute(sql`
      select 1 from appointments a
      where a.tenant_id = ${tenantId} and a.customer_id = ${customerId} and a.status <> 'cancelled' ${scopeSql(scope)}
      limit 1`);
    if (res.rows.length) return cu;
  }
  throw new AppError(403, 'record_forbidden', 'Only owners, admins and who attended this customer can see the record');
}

const userName = async (id: string) => (await getDb().query.users.findFirst({ where: eq(users.id, id), columns: { name: true } }))?.name ?? null;

recordRoutes.get('/customers/:id/record', async (c) => {
  const customerId = c.req.param('id');
  await assertAccess(c, customerId);
  const db = getDb();
  const tenantId = c.get('tenantId');
  const rec = await db.query.customerRecords.findFirst({ where: eq(customerRecords.customerId, customerId) });
  const notes = await db.select().from(recordNotes).where(and(eq(recordNotes.tenantId, tenantId), eq(recordNotes.customerId, customerId))).orderBy(desc(recordNotes.createdAt));
  // Studies (lab, imaging, documents) belong to the clinical record, not to the photo gallery.
  const photos = await db
    .select()
    .from(recordPhotos)
    .where(and(eq(recordPhotos.tenantId, tenantId), eq(recordPhotos.customerId, customerId), inArray(recordPhotos.kind, ['before', 'after', 'other'])))
    .orderBy(desc(recordPhotos.createdAt));
  const body: CustomerRecordDto = {
    allergies: dec(rec?.allergiesEnc ?? null),
    conditions: dec(rec?.conditionsEnc ?? null),
    consentAt: rec?.consentAt?.toISOString() ?? null,
    consentByName: rec?.consentBy ? await userName(rec.consentBy) : null,
    notes: notes.map((n) => ({ id: n.id, body: dec(n.bodyEnc) ?? '', appointmentId: n.appointmentId, authorName: n.authorName, createdAt: n.createdAt.toISOString() })),
    photos: photos.map((p) => ({ id: p.id, kind: p.kind as 'before' | 'after' | 'other', note: dec(p.noteEnc), appointmentId: p.appointmentId, sizeBytes: p.sizeBytes, createdAt: p.createdAt.toISOString() })),
    photosEnabled: Boolean(photoToken()),
    responses: await listResponses(db, tenantId, { customerId }),
  };
  c.header('Cache-Control', 'private, no-store');
  return c.json(body);
});

recordRoutes.put('/customers/:id/record', async (c) => {
  const customerId = c.req.param('id');
  await assertAccess(c, customerId);
  const input = recordUpdateSchema.parse(await c.req.json());
  const db = getDb();
  const userId = c.get('userId');
  const values = {
    ...(input.allergies !== undefined ? { allergiesEnc: enc(input.allergies) } : {}),
    ...(input.conditions !== undefined ? { conditionsEnc: enc(input.conditions) } : {}),
    ...(input.consent === true ? { consentAt: new Date(), consentBy: userId } : input.consent === false ? { consentAt: null, consentBy: null } : {}),
    updatedBy: userId,
    updatedAt: new Date(),
  };
  await db
    .insert(customerRecords)
    .values({ customerId, tenantId: c.get('tenantId'), ...values })
    .onConflictDoUpdate({ target: customerRecords.customerId, set: values });
  return c.json({ ok: true });
});

recordRoutes.post('/customers/:id/record/notes', async (c) => {
  const customerId = c.req.param('id');
  await assertAccess(c, customerId);
  const input = recordNoteSchema.parse(await c.req.json());
  const userId = c.get('userId');
  const [row] = await getDb()
    .insert(recordNotes)
    .values({ tenantId: c.get('tenantId'), customerId, appointmentId: input.appointmentId ?? null, bodyEnc: encryptSecret(input.body), authorId: userId, authorName: await userName(userId) })
    .returning();
  return c.json({ id: row!.id, body: input.body, appointmentId: row!.appointmentId, authorName: row!.authorName, createdAt: row!.createdAt.toISOString() }, 201);
});

/** Notes are a history: only their author or an owner can remove one. */
recordRoutes.delete('/record-notes/:id', async (c) => {
  const db = getDb();
  const n = await db.query.recordNotes.findFirst({ where: and(eq(recordNotes.id, c.req.param('id')), eq(recordNotes.tenantId, c.get('tenantId'))) });
  if (!n) throw notFound('note');
  await assertAccess(c, n.customerId);
  if (c.get('role') !== 'owner' && n.authorId !== c.get('userId')) throw new AppError(403, 'forbidden', 'Only the author or the owner');
  await db.delete(recordNotes).where(eq(recordNotes.id, n.id));
  return c.body(null, 204);
});

recordRoutes.post('/customers/:id/record/photos', async (c) => {
  const customerId = c.req.param('id');
  await assertAccess(c, customerId);
  const token = photoToken();
  if (!token) throw new AppError(502, 'record_photos_not_configured', 'Private photo storage is not connected yet');
  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) throw new AppError(422, 'validation_error', 'Send the picture in the "file" field');
  const ext = TYPES[file.type];
  if (!ext) throw new AppError(422, 'unsupported_image', 'Use a JPG, PNG or WebP picture');
  if (file.size > RECORD_PHOTO_MAX_BYTES) throw new AppError(422, 'image_too_large', 'The picture is larger than 5 MB');
  const kind = ['before', 'after', 'other'].includes(String(body['kind'])) ? (String(body['kind']) as 'before' | 'after' | 'other') : 'other';
  const note = typeof body['note'] === 'string' && body['note'].trim() ? body['note'].trim().slice(0, 1000) : null;
  const appointmentId = typeof body['appointmentId'] === 'string' && /^[0-9a-f-]{36}$/.test(body['appointmentId']) ? body['appointmentId'] : null;
  const tenantId = c.get('tenantId');
  const db = getDb();
  await assertPhotoRoom(db, tenantId, file.size);
  // Random, unguessable path; the store is private anyway.
  const blob = await put(`records/${tenantId}/${randomUUID()}/${randomUUID()}.${ext}`, file, { access: 'private', token, contentType: file.type });
  const [row] = await db
    .insert(recordPhotos)
    .values({ tenantId, customerId, appointmentId, kind, noteEnc: enc(note), blobPath: blob.url, sizeBytes: file.size, contentType: file.type, createdBy: c.get('userId') })
    .returning();
  return c.json({ id: row!.id, kind, note, appointmentId, sizeBytes: file.size, createdAt: row!.createdAt.toISOString() }, 201);
});

const loadPhoto = async (c: Context<AppEnv>) => {
  const p = await getDb().query.recordPhotos.findFirst({ where: and(eq(recordPhotos.id, c.req.param('id')!), eq(recordPhotos.tenantId, c.get('tenantId'))) });
  if (!p) throw notFound('photo');
  await assertAccess(c, p.customerId);
  return p;
};

/** Streams a private photo to an authorized user; never cached by shared caches. */
recordRoutes.get('/record-photos/:id', async (c) => {
  const p = await loadPhoto(c);
  const token = photoToken();
  if (!token) throw new AppError(502, 'record_photos_not_configured', 'Private photo storage is not connected yet');
  const res = await fetch(p.blobPath, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok || !res.body) throw notFound('photo');
  return new Response(res.body, {
    headers: { 'content-type': p.contentType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' },
  });
});

recordRoutes.delete('/record-photos/:id', async (c) => {
  const p = await loadPhoto(c);
  const token = photoToken();
  if (token) await del(p.blobPath, { token }).catch(() => undefined);
  await getDb().delete(recordPhotos).where(eq(recordPhotos.id, p.id));
  return c.body(null, 204);
});

/** Removes a customer's photos from storage (called before deleting the customer). */
export async function deleteCustomerPhotos(tenantId: string, customerId: string) {
  const rows = await getDb()
    .select({ url: recordPhotos.blobPath })
    .from(recordPhotos)
    .where(and(eq(recordPhotos.tenantId, tenantId), eq(recordPhotos.customerId, customerId)));
  const token = photoToken();
  if (!rows.length || !token) return;
  await del(rows.map((r) => r.url), { token });
}
