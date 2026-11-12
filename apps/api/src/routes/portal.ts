import { Hono } from 'hono';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ageOn, isHealthType, type PortalDto, type PrescriptionCheckDto } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { clinicalNotes, customers, recordAccessLog, recordPhotos, tenants } from '../db/schema.js';
import { decryptSecret, manageToken, PORTAL_DAYS, portalCode, portalToken, portalTokenExpiry, verifyPortalCode, verifyPortalToken, verifyPrescriptionToken } from '../lib/crypto.js';
import { escapeHtml, sendEmail } from '../lib/email.js';
import { AppError, notFound } from '../lib/errors.js';
import { appUrl, isUndeliverable } from '../lib/notify.js';
import { assertNotLimited, clientIp, recordAttempt } from '../lib/throttle.js';
import { assertCaptcha } from '../lib/captcha.js';
import { listStudies, toDtos } from './clinical.js';
import { photoToken } from './records.js';
import { getTenantBySlug } from './public.js';

/**
 * Patient portal and public prescription check. No passwords: the patient asks for a link by
 * email (only sent if that email belongs to a patient of the business) and the link is a signed,
 * expiring token. The portal shows their appointments and only the documents and studies the
 * practitioner chose to share.
 */
export const portalRoutes = new Hono();

const tokenOf = (c: { req: { header: (n: string) => string | undefined; query: (n: string) => string | undefined } }) =>
  c.req.header('x-portal-token') ?? c.req.query('t') ?? null;

portalRoutes.post('/public/:slug/portal/link', async (c) => {
  const tenant = await getTenantBySlug(c.req.param('slug'));
  const { email } = z.object({ email: z.string().trim().toLowerCase().email().max(200) }).parse(await c.req.json());
  const db = getDb();
  const limits = [
    { key: `portal:${email}`, max: 3, minutes: 60 },
    { key: `portal-ip:${clientIp(c)}`, max: 10, minutes: 60 },
  ];
  await assertNotLimited(db, limits);
  await assertCaptcha(c);
  await recordAttempt(db, limits);
  const cu = await db.query.customers.findFirst({
    where: and(eq(customers.tenantId, tenant.id), sql`lower(${customers.email}) = ${email}`),
    orderBy: desc(customers.createdAt),
  });
  if (cu && !isUndeliverable(email)) {
    const link = `${appUrl()}/p/${tenant.slug}?t=${portalToken(cu.id)}`;
    const code = portalCode(cu.id);
    const first = cu.name.split(' ')[0] ?? cu.name;
    const word = isHealthType(tenant.businessType) ? 'tus citas, recetas y estudios' : 'tus citas';
    await sendEmail({
      to: email,
      subject: `Tu código de acceso a ${tenant.name}: ${code}`,
      text: `Hola ${first}:\n\nTu código para entrar es ${code} (vale 10 minutos).\n\nO entra directo con este enlace para ver ${word}:\n${link}\n\nUna vez dentro, tu teléfono recuerda tu sesión. Si no lo pediste, ignora este correo.\n\n— ${tenant.name}`,
      html: `<div style="font-family:system-ui,sans-serif;color:#0f172a"><p>Hola ${escapeHtml(first)}:</p><p>Tu código para entrar es</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p style="color:#64748b;font-size:13px">Vale 10 minutos.</p><p>O entra directo para ver ${escapeHtml(word)}:</p><p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#0f766e;color:#fff;border-radius:8px;text-decoration:none">Entrar a mi portal</a></p><p style="color:#64748b;font-size:13px">Una vez dentro, tu teléfono recuerda tu sesión. Si no lo pediste, ignora este correo.</p><p style="color:#475569">${escapeHtml(tenant.name)}</p></div>`,
    });
  }
  // Same answer either way: nobody can find out who is a patient here.
  return c.json({ ok: true });
});

/** Signs in with the 6-digit code from the email (when the link opens on another device). */
portalRoutes.post('/public/:slug/portal/code', async (c) => {
  const tenant = await getTenantBySlug(c.req.param('slug'));
  const { email, code } = z.object({ email: z.string().trim().toLowerCase().email().max(200), code: z.string().trim().regex(/^\d{6}$/) }).parse(await c.req.json());
  const db = getDb();
  const limits = [
    { key: `portal-code:${email}`, max: 5, minutes: 15 },
    { key: `portal-code-ip:${clientIp(c)}`, max: 20, minutes: 15 },
  ];
  await assertNotLimited(db, limits);
  const cu = await db.query.customers.findFirst({
    where: and(eq(customers.tenantId, tenant.id), sql`lower(${customers.email}) = ${email}`),
    orderBy: desc(customers.createdAt),
  });
  if (!cu || !verifyPortalCode(cu.id, code)) {
    await recordAttempt(db, limits);
    throw new AppError(422, 'portal_bad_code', 'The code is not valid or expired');
  }
  return c.json({ token: portalToken(cu.id) });
});

async function portalCustomer(c: Parameters<typeof tokenOf>[0]) {
  const customerId = verifyPortalToken(tokenOf(c));
  if (!customerId) throw new AppError(401, 'portal_expired', 'The link expired; ask for a new one');
  const db = getDb();
  const cu = await db.query.customers.findFirst({ where: eq(customers.id, customerId) });
  if (!cu) throw new AppError(401, 'portal_expired', 'The link expired; ask for a new one');
  const t = (await db.query.tenants.findFirst({ where: eq(tenants.id, cu.tenantId) }))!;
  return { cu, t, db };
}

portalRoutes.get('/public/portal', async (c) => {
  const { cu, t, db } = await portalCustomer(c);
  const appts = await db.execute<{ id: string; starts_at: Date; status: string; service: string | null; resource: string | null }>(sql`
    select a.id, a.starts_at, a.status, s.name as service, r.name as resource
    from appointments a left join services s on s.id = a.service_id left join resources r on r.id = a.resource_id
    where a.tenant_id = ${t.id} and a.customer_id = ${cu.id}
    order by a.starts_at desc limit 30`);
  const health = isHealthType(t.businessType);
  const shared = health
    ? await db
        .select()
        .from(clinicalNotes)
        .where(and(eq(clinicalNotes.tenantId, t.id), eq(clinicalNotes.customerId, cu.id), eq(clinicalNotes.status, 'signed'), isNotNull(clinicalNotes.sharedAt)))
        .orderBy(desc(clinicalNotes.signedAt))
    : [];
  const token = tokenOf(c)!;
  const studies = health && photoToken() ? await listStudies(db, t.id, cu.id, true) : [];
  await db.insert(recordAccessLog).values({ tenantId: t.id, customerId: cu.id, userId: null, userName: `${cu.name} (portal)`, action: 'portal', detail: null });
  const body: PortalDto = {
    business: {
      name: t.name,
      slug: t.slug,
      phone: t.phone,
      address: [t.address, t.neighborhood, t.city].filter(Boolean).join(', ') || null,
      logoUrl: t.settings.page?.logoUrl ?? null,
      businessType: t.businessType,
    },
    patient: { name: cu.name },
    appointments: appts.rows.map((a) => ({
      id: a.id,
      startsAt: new Date(a.starts_at).toISOString(),
      status: a.status,
      serviceName: a.service,
      resourceName: a.resource,
      managePath: `/c/${manageToken(a.id)}`,
    })),
    documents: await toDtos(db, t.id, shared),
    studies: studies.map((s) => ({ ...s, url: `/api/public/portal/files/${s.id}?t=${encodeURIComponent(token)}` })),
    // Sliding session: a visit after a month gets a fresh 90-day token
    renewedToken: (portalTokenExpiry(token) ?? 0) - Date.now() < (PORTAL_DAYS - 30) * 864e5 ? portalToken(cu.id) : null,
  };
  c.header('Cache-Control', 'private, no-store');
  return c.json(body);
});

portalRoutes.get('/public/portal/files/:id', async (c) => {
  const { cu, db } = await portalCustomer(c);
  const st = await db.query.recordPhotos.findFirst({ where: and(eq(recordPhotos.id, c.req.param('id')), eq(recordPhotos.customerId, cu.id), isNotNull(recordPhotos.sharedAt)) });
  const token = photoToken();
  if (!st || !token) throw notFound('study');
  const res = await fetch(st.blobPath, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok || !res.body) throw notFound('study');
  return new Response(res.body, { headers: { 'content-type': st.contentType, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
});

/** Public page of a signed prescription: the pharmacy or the patient checks it is authentic. */
portalRoutes.get('/public/prescriptions/:token', async (c) => {
  const id = verifyPrescriptionToken(c.req.param('token'));
  if (!id) throw notFound('prescription');
  const db = getDb();
  const n = await db.query.clinicalNotes.findFirst({ where: and(eq(clinicalNotes.id, id), eq(clinicalNotes.status, 'signed'), eq(clinicalNotes.kind, 'prescription')) });
  if (!n || !n.author || !n.signedAt || !n.contentHash) throw notFound('prescription');
  const cu = (await db.query.customers.findFirst({ where: eq(customers.id, n.customerId) }))!;
  const t = (await db.query.tenants.findFirst({ where: eq(tenants.id, n.tenantId) }))!;
  let content: Record<string, unknown> = {};
  try {
    content = JSON.parse(decryptSecret(n.contentEnc)) as Record<string, unknown>;
  } catch {
    content = {};
  }
  const body: PrescriptionCheckDto = {
    clinic: {
      name: t.name,
      legalName: t.settings.clinic?.legalName ?? null,
      healthLicense: t.settings.clinic?.healthLicense ?? null,
      address: [t.address, t.neighborhood, t.city, t.state].filter(Boolean).join(', ') || null,
      phone: t.phone,
    },
    doctor: n.author,
    patient: { name: cu.name, age: ageOn(cu.birthday) },
    signedAt: n.signedAt.toISOString(),
    contentHash: n.contentHash,
    // Only what a prescription carries
    content: { medicamentos: content.medicamentos, indicaciones: content.indicaciones, diagnostico: content.diagnostico },
  };
  c.header('Cache-Control', 'private, no-store');
  return c.json(body);
});
