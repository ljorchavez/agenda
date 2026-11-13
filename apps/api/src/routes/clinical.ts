import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  clinicalTemplateById,
  noteTemplate,
  CLINICAL_TEMPLATES_BY_TYPE,
  clinicalAddendumSchema,
  clinicalNormFor,
  clinicalNoteInputSchema,
  clinicalSignSchema,
  isHealthType,
  missingRequired,
  type ClinicalAuthor,
  type ClinicalLogDto,
  type ClinicalNoteDto,
  type ClinicalRecordDto,
  type Odontogram,
  type StudyDto,
  type StudyKind,
  STUDY_KINDS,
  STUDY_MAX_BYTES,
} from '@agenda/shared';
import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
import { z } from 'zod';
import { assertPhotoRoom } from '../lib/plan.js';
import { sendEmail } from '../lib/email.js';
import { renderEmail } from '../lib/email-layout.js';
import { appUrl } from '../lib/notify.js';
import { getDb, type Db } from '../db/client.js';
import { appointments, clinicalNotes, customerRecords, customers, recordAccessLog, recordPhotos, tenants, users, type ClinicalNote } from '../db/schema.js';
import { verifyPassword } from '../lib/auth.js';
import { decryptSecret, encryptSecret, prescriptionToken } from '../lib/crypto.js';
import { AppError, notFound } from '../lib/errors.js';
import type { AppEnv } from '../middleware/auth.js';
import { assertAccess, photoToken } from './records.js';

/**
 * Clinical record of health businesses (NOM-004-SSA3-2012; dentistry NOM-013-SSA2-2015):
 * historia clínica, notas de evolución, receta, referencia, interconsulta and consentimiento.
 * - Content is encrypted; access follows the client record rules (owner, admins, who attended).
 * - Drafts can be edited by their author. Signing (password again) stamps date, time, author with
 *   cédula and a SHA-256 of the content; a signed document never changes: corrections are a
 *   signed "nota aclaratoria".
 * - Every opening, signature, print and export goes to the bitácora.
 */
export const clinicalRoutes = new Hono<AppEnv>();

type C = Context<AppEnv>;

async function healthTenant(db: Db, tenantId: string) {
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!t || !isHealthType(t.businessType)) throw new AppError(422, 'clinical_not_health', 'Only health businesses keep a clinical record');
  return t;
}

const me = async (db: Db, c: C) => (await db.query.users.findFirst({ where: eq(users.id, c.get('userId')) }))!;
const authorOf = (u: { name: string; professional: ClinicalAuthor | Record<string, unknown> | null }): ClinicalAuthor => {
  const p = (u.professional ?? {}) as Partial<ClinicalAuthor>;
  return { name: u.name, license: p.license ?? null, institution: p.institution ?? null, specialty: p.specialty ?? null, specialtyLicense: p.specialtyLicense ?? null };
};

export async function logAccess(db: Pick<Db, 'insert'>, c: C, customerId: string, action: string, detail: string | null = null, userName?: string) {
  await db.insert(recordAccessLog).values({ tenantId: c.get('tenantId'), customerId, userId: c.get('userId'), userName: userName ?? null, action, detail });
}

const decode = (n: ClinicalNote): Record<string, unknown> => {
  try {
    return JSON.parse(decryptSecret(n.contentEnc)) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/** What the signature covers: content, template, patient, author and moment. */
export const signatureHash = (o: { content: unknown; template: string; customerId: string; author: ClinicalAuthor; signedAt: Date }) =>
  createHash('sha256')
    .update(JSON.stringify({ c: o.content, t: o.template, p: o.customerId, a: o.author, s: o.signedAt.toISOString() }))
    .digest('hex');

export async function toDtos(db: Db, tenantId: string, rows: ClinicalNote[]): Promise<ClinicalNoteDto[]> {
  const apptIds = [...new Set(rows.map((r) => r.appointmentId).filter((x): x is string => Boolean(x)))];
  const appts = apptIds.length
    ? (
        await db.execute<{ id: string; starts_at: Date; service: string }>(sql`
          select a.id, a.starts_at, s.name as service from appointments a join services s on s.id = a.service_id
          where a.tenant_id = ${tenantId} and a.id in (${sql.join(apptIds.map((id) => sql`${id}`), sql`, `)})`)
      ).rows
    : [];
  return rows.map((n) => {
    const a = appts.find((x) => x.id === n.appointmentId);
    return {
      id: n.id,
      template: n.template,
      kind: n.kind as ClinicalNoteDto['kind'],
      title: n.title,
      appointmentId: n.appointmentId,
      appointmentAt: a ? new Date(a.starts_at).toISOString() : null,
      serviceName: a?.service ?? null,
      content: decode(n),
      status: n.status,
      author: n.author ?? null,
      authorId: n.authorId,
      signedAt: n.signedAt?.toISOString() ?? null,
      contentHash: n.contentHash,
      amendsId: n.amendsId,
      sharedAt: n.sharedAt?.toISOString() ?? null,
      verifyPath: n.status === 'signed' && n.kind === 'prescription' ? `/receta/${prescriptionToken(n.id)}` : null,
      createdAt: n.createdAt.toISOString(),
    };
  });
}

async function loadNote(c: C, id: string) {
  const db = getDb();
  const n = await db.query.clinicalNotes.findFirst({ where: and(eq(clinicalNotes.id, id), eq(clinicalNotes.tenantId, c.get('tenantId'))) });
  if (!n) throw notFound('clinical_note');
  await assertAccess(c, n.customerId);
  return n;
}

async function checkPassword(db: Db, c: C, password: string) {
  const u = await me(db, c);
  if (!(await verifyPassword(password, u.passwordHash))) throw new AppError(422, 'wrong_password', 'Password is incorrect');
  return u;
}

clinicalRoutes.get('/customers/:id/clinical', async (c) => {
  const customerId = c.req.param('id');
  const cu = await assertAccess(c, customerId);
  const db = getDb();
  const t = await healthTenant(db, c.get('tenantId'));
  const rows = await db
    .select()
    .from(clinicalNotes)
    .where(and(eq(clinicalNotes.tenantId, t.id), eq(clinicalNotes.customerId, customerId)))
    .orderBy(desc(clinicalNotes.createdAt));
  // Drafts are only visible to their author
  const visible = rows.filter((n) => n.status === 'signed' || n.authorId === c.get('userId'));
  const notes = await toDtos(db, t.id, visible);
  const lastOdonto = notes.filter((n) => n.status === 'signed').find((n) => n.content.odontograma && Object.keys(n.content.odontograma as object).length);
  const u = await me(db, c);
  await logAccess(db, c, customerId, 'view', null, u.name);
  const rec = await db.query.customerRecords.findFirst({ where: eq(customerRecords.customerId, customerId) });
  let recAllergies: string | null = null;
  try {
    recAllergies = rec?.allergiesEnc ? decryptSecret(rec.allergiesEnc) : null;
  } catch {
    recAllergies = null;
  }
  const histAllergies = notes.find((n) => n.status === 'signed' && n.kind === 'history' && typeof n.content.alergias === 'string')?.content.alergias as string | undefined;
  const allergies = [recAllergies, histAllergies].filter((x): x is string => Boolean(x && x.trim())).join('; ') || null;
  const body: ClinicalRecordDto = {
    norm: clinicalNormFor(t.businessType),
    patient: {
      id: cu.id,
      name: cu.name,
      phone: cu.phone,
      email: cu.email,
      birthday: cu.birthday,
      sex: cu.sex ?? null,
      address: cu.address ?? null,
      curp: cu.curp ?? null,
      archived: Boolean(cu.archivedAt),
      allergies,
    },
    clinic: {
      name: t.name,
      legalName: t.settings.clinic?.legalName ?? null,
      healthLicense: t.settings.clinic?.healthLicense ?? null,
      address: [t.address, t.neighborhood, t.city, t.state].filter(Boolean).join(', ') || null,
      phone: t.phone,
    },
    notes,
    studies: await listStudies(db, t.id, customerId),
    studiesEnabled: Boolean(photoToken()),
    odontogram: (lastOdonto?.content.odontograma as Odontogram | undefined) ?? null,
  };
  c.header('Cache-Control', 'private, no-store');
  return c.json(body);
});

/** New document: a draft, or signed right away when `password` comes with it. */
clinicalRoutes.post('/customers/:id/clinical-notes', async (c) => {
  const customerId = c.req.param('id');
  await assertAccess(c, customerId);
  const db = getDb();
  const t = await healthTenant(db, c.get('tenantId'));
  const body = await c.req.json();
  const input = clinicalNoteInputSchema.parse(body);
  const custom = t.settings.clinicalTemplates ?? [];
  const own = custom.find((x) => x.id === input.template);
  const tpl = clinicalTemplateById(input.template, t.businessType, custom);
  if (!tpl || (!own && !(CLINICAL_TEMPLATES_BY_TYPE[t.businessType] ?? []).includes(tpl.id))) throw new AppError(422, 'clinical_template', 'Unknown document for this business');
  // The business's own templates travel with the document (see noteTemplate)
  if (own) input.content.__template = own;
  if (input.appointmentId) {
    const a = await db.query.appointments.findFirst({ where: and(eq(appointments.id, input.appointmentId), eq(appointments.tenantId, t.id), eq(appointments.customerId, customerId)) });
    if (!a) throw notFound('appointment');
  }
  const password = typeof body.password === 'string' ? body.password : null;
  const u = password ? await checkPassword(db, c, password) : await me(db, c);
  const author = authorOf(u);
  let signed: { signedAt: Date; contentHash: string } | null = null;
  if (password) {
    const miss = missingRequired(tpl, input.content);
    if (miss) throw new AppError(422, 'clinical_incomplete', `Missing: ${miss}`, { field: miss });
    const signedAt = new Date();
    signed = { signedAt, contentHash: signatureHash({ content: input.content, template: tpl.id, customerId, author, signedAt }) };
  }
  const [row] = await db
    .insert(clinicalNotes)
    .values({
      tenantId: t.id,
      customerId,
      appointmentId: input.appointmentId ?? null,
      template: tpl.id,
      kind: tpl.kind,
      title: tpl.title,
      contentEnc: encryptSecret(JSON.stringify(input.content)),
      status: signed ? 'signed' : 'draft',
      authorId: u.id,
      author,
      signedAt: signed?.signedAt ?? null,
      contentHash: signed?.contentHash ?? null,
    })
    .returning();
  await logAccess(db, c, customerId, signed ? 'sign' : 'draft', tpl.title, u.name);
  return c.json((await toDtos(db, t.id, [row!]))[0], 201);
});

/** Only drafts change, and only by their author. */
clinicalRoutes.put('/clinical-notes/:id', async (c) => {
  const n = await loadNote(c, c.req.param('id'));
  if (n.status === 'signed') throw new AppError(409, 'clinical_signed', 'A signed document cannot be changed; add a nota aclaratoria');
  if (n.authorId !== c.get('userId')) throw new AppError(403, 'forbidden', 'Only the author edits a draft');
  const input = clinicalNoteInputSchema.pick({ content: true }).parse(await c.req.json());
  const before = decode(n);
  if (before.__template) input.content.__template = before.__template;
  const db = getDb();
  const [row] = await db.update(clinicalNotes).set({ contentEnc: encryptSecret(JSON.stringify(input.content)), updatedAt: new Date() }).where(eq(clinicalNotes.id, n.id)).returning();
  return c.json((await toDtos(db, n.tenantId, [row!]))[0]);
});

clinicalRoutes.post('/clinical-notes/:id/sign', async (c) => {
  const n = await loadNote(c, c.req.param('id'));
  if (n.status === 'signed') throw new AppError(409, 'clinical_signed', 'Already signed');
  if (n.authorId !== c.get('userId')) throw new AppError(403, 'forbidden', 'Only the author signs');
  const { password } = clinicalSignSchema.parse(await c.req.json());
  const db = getDb();
  const u = await checkPassword(db, c, password);
  const content = decode(n);
  const t = await healthTenant(db, n.tenantId);
  const tpl = noteTemplate({ template: n.template, content }, t.businessType, t.settings.clinicalTemplates ?? []);
  const miss = tpl ? missingRequired(tpl, content) : null;
  if (miss) throw new AppError(422, 'clinical_incomplete', `Missing: ${miss}`, { field: miss });
  const author = authorOf(u);
  const signedAt = new Date();
  const [row] = await db
    .update(clinicalNotes)
    .set({ status: 'signed', author, signedAt, contentHash: signatureHash({ content, template: n.template, customerId: n.customerId, author, signedAt }), updatedAt: signedAt })
    .where(and(eq(clinicalNotes.id, n.id), eq(clinicalNotes.status, 'draft')))
    .returning();
  await logAccess(db, c, n.customerId, 'sign', n.title, u.name);
  return c.json((await toDtos(db, n.tenantId, [row!]))[0]);
});

clinicalRoutes.delete('/clinical-notes/:id', async (c) => {
  const n = await loadNote(c, c.req.param('id'));
  if (n.status === 'signed') throw new AppError(409, 'clinical_signed', 'A signed document cannot be deleted');
  if (n.authorId !== c.get('userId')) throw new AppError(403, 'forbidden', 'Only the author deletes a draft');
  await getDb().delete(clinicalNotes).where(eq(clinicalNotes.id, n.id));
  return c.body(null, 204);
});

/** Corrections to a signed document: a new signed note linked to it. */
clinicalRoutes.post('/clinical-notes/:id/addendum', async (c) => {
  const n = await loadNote(c, c.req.param('id'));
  if (n.status !== 'signed') throw new AppError(422, 'clinical_not_signed', 'Edit the draft instead');
  const { text, password } = clinicalAddendumSchema.parse(await c.req.json());
  const db = getDb();
  const u = await checkPassword(db, c, password);
  const author = authorOf(u);
  const signedAt = new Date();
  const content = { texto: text, sobre: `${n.title} del ${n.signedAt?.toISOString().slice(0, 10)}` };
  const [row] = await db
    .insert(clinicalNotes)
    .values({
      tenantId: n.tenantId,
      customerId: n.customerId,
      appointmentId: n.appointmentId,
      template: 'addendum',
      kind: 'addendum',
      title: 'Nota aclaratoria',
      contentEnc: encryptSecret(JSON.stringify(content)),
      status: 'signed',
      authorId: u.id,
      author,
      signedAt,
      contentHash: signatureHash({ content, template: 'addendum', customerId: n.customerId, author, signedAt }),
      amendsId: n.id,
    })
    .returning();
  await logAccess(db, c, n.customerId, 'addendum', n.title, u.name);
  return c.json((await toDtos(db, n.tenantId, [row!]))[0], 201);
});

/** The app reports prints and exports of documents (bitácora). */
clinicalRoutes.post('/customers/:id/clinical-log', async (c) => {
  const customerId = c.req.param('id');
  await assertAccess(c, customerId);
  const body = (await c.req.json().catch(() => ({}))) as { action?: string; detail?: string };
  const action = body.action === 'export' || body.action === 'send' ? body.action : 'print';
  const db = getDb();
  await logAccess(db, c, customerId, action, typeof body.detail === 'string' ? body.detail.slice(0, 200) : null, (await me(db, c)).name);
  return c.body(null, 204);
});

/** Bitácora: owners and admins. */
clinicalRoutes.get('/customers/:id/clinical-log', async (c) => {
  const customerId = c.req.param('id');
  await assertAccess(c, customerId);
  if (c.get('role') !== 'owner' && c.get('role') !== 'admin') throw new AppError(403, 'forbidden', 'Owners and admins only');
  const rows = await getDb()
    .select()
    .from(recordAccessLog)
    .where(and(eq(recordAccessLog.tenantId, c.get('tenantId')), eq(recordAccessLog.customerId, customerId)))
    .orderBy(desc(recordAccessLog.createdAt))
    .limit(200);
  const out: ClinicalLogDto[] = rows.map((r) => ({ userName: r.userName ?? '', action: r.action, detail: r.detail, createdAt: r.createdAt.toISOString() }));
  return c.json(out);
});


// ---------- Studies: lab results, imaging, documents (private storage) ----------

const STUDY_TYPES: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export async function listStudies(db: Db, tenantId: string, customerId: string, onlyShared = false): Promise<StudyDto[]> {
  const rows = await db
    .select()
    .from(recordPhotos)
    .where(and(eq(recordPhotos.tenantId, tenantId), eq(recordPhotos.customerId, customerId), inArray(recordPhotos.kind, [...STUDY_KINDS])))
    .orderBy(desc(recordPhotos.createdAt));
  return rows
    .filter((r) => !onlyShared || r.sharedAt)
    .map((r) => {
      let title: string | null = null;
      try {
        title = r.noteEnc ? decryptSecret(r.noteEnc) : null;
      } catch {
        title = null;
      }
      return { id: r.id, kind: r.kind as StudyKind, title, contentType: r.contentType, sizeBytes: r.sizeBytes, sharedAt: r.sharedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString() };
    });
}

clinicalRoutes.post('/customers/:id/clinical/studies', async (c) => {
  const customerId = c.req.param('id');
  await assertAccess(c, customerId);
  const db = getDb();
  const t = await healthTenant(db, c.get('tenantId'));
  const token = photoToken();
  if (!token) throw new AppError(502, 'record_photos_not_configured', 'Private file storage is not connected yet');
  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) throw new AppError(422, 'validation_error', 'Send the file in the "file" field');
  const ext = STUDY_TYPES[file.type];
  if (!ext) throw new AppError(422, 'unsupported_study', 'Use a PDF, JPG, PNG or WebP file');
  if (file.size > STUDY_MAX_BYTES) throw new AppError(422, 'study_too_large', 'The file is larger than 10 MB');
  const kind = (STUDY_KINDS as readonly string[]).includes(String(body['kind'])) ? (String(body['kind']) as StudyKind) : 'document';
  const title = typeof body['title'] === 'string' && body['title'].trim() ? body['title'].trim().slice(0, 200) : null;
  await assertPhotoRoom(db, t.id, file.size);
  const blob = await put(`records/${t.id}/${randomUUID()}/${randomUUID()}.${ext}`, file, { access: 'private', token, contentType: file.type });
  const [row] = await db
    .insert(recordPhotos)
    .values({ tenantId: t.id, customerId, kind, noteEnc: title ? encryptSecret(title) : null, blobPath: blob.url, sizeBytes: file.size, contentType: file.type, createdBy: c.get('userId') })
    .returning();
  const u = await me(db, c);
  await logAccess(db, c, customerId, 'study', title ?? kind, u.name);
  return c.json({ id: row!.id, kind, title, contentType: file.type, sizeBytes: file.size, sharedAt: null, createdAt: row!.createdAt.toISOString() } satisfies StudyDto, 201);
});

/** Show or hide a signed document in the patient's portal. */
clinicalRoutes.post('/clinical-notes/:id/share', async (c) => {
  const n = await loadNote(c, c.req.param('id'));
  if (n.status !== 'signed') throw new AppError(409, 'clinical_draft', 'Sign the document before sharing it');
  const { shared } = z.object({ shared: z.boolean() }).parse(await c.req.json());
  const db = getDb();
  const [row] = await db.update(clinicalNotes).set({ sharedAt: shared ? new Date() : null }).where(eq(clinicalNotes.id, n.id)).returning();
  const u = await me(db, c);
  await logAccess(db, c, n.customerId, shared ? 'share' : 'unshare', n.title, u.name);
  return c.json((await toDtos(db, n.tenantId, [row!]))[0]);
});

clinicalRoutes.post('/studies/:id/share', async (c) => {
  const db = getDb();
  const st = await db.query.recordPhotos.findFirst({ where: and(eq(recordPhotos.id, c.req.param('id')), eq(recordPhotos.tenantId, c.get('tenantId'))) });
  if (!st || !(STUDY_KINDS as readonly string[]).includes(st.kind)) throw notFound('study');
  await assertAccess(c, st.customerId);
  const { shared } = z.object({ shared: z.boolean() }).parse(await c.req.json());
  await db.update(recordPhotos).set({ sharedAt: shared ? new Date() : null }).where(eq(recordPhotos.id, st.id));
  const u = await me(db, c);
  await logAccess(db, c, st.customerId, shared ? 'share' : 'unshare', 'study', u.name);
  return c.json((await listStudies(db, st.tenantId, st.customerId)).find((x) => x.id === st.id));
});

/** Emails the patient the link to their signed prescription (with its verification page). */
clinicalRoutes.post('/clinical-notes/:id/send', async (c) => {
  const n = await loadNote(c, c.req.param('id'));
  if (n.status !== 'signed' || n.kind !== 'prescription') throw new AppError(409, 'clinical_draft', 'Only signed prescriptions are sent');
  const db = getDb();
  const cu = await db.query.customers.findFirst({ where: eq(customers.id, n.customerId) });
  if (!cu?.email) throw new AppError(422, 'customer_no_email', 'The patient has no email');
  const t = (await db.query.tenants.findFirst({ where: eq(tenants.id, n.tenantId) }))!;
  const link = `${appUrl()}/receta/${prescriptionToken(n.id)}`;
  const first = cu.name.split(' ')[0] ?? cu.name;
  const sent = await sendEmail({
    to: cu.email,
    subject: `Tu receta de ${t.name}`,
    text: `Hola ${first}:\n\nAquí está tu receta. Puedes verla, imprimirla o mostrarla en la farmacia:\n${link}\n\n— ${t.name}`,
    html: renderEmail({
      preheader: 'Puedes verla, imprimirla o mostrarla en la farmacia.',
      brand: { name: t.name },
      badge: { text: 'Receta médica', tone: 'info' },
      title: 'Aquí está tu receta',
      intro: [`Hola ${first}:`, 'Tu receta ya está firmada. Puedes verla, imprimirla o mostrarla en la farmacia desde tu teléfono.'],
      button: { label: 'Ver receta', href: link },
      outro: ['La receta incluye un código para que la farmacia verifique que es auténtica.'],
    }),
  });
  if (!sent) throw new AppError(502, 'email_failed', 'The email could not be sent');
  const u = await me(db, c);
  await logAccess(db, c, n.customerId, 'send', `${n.title} (correo)`, u.name);
  return c.json({ ok: true });
});
