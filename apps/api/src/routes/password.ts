import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { forgotPasswordSchema, resetPasswordSchema } from '@agenda/shared';
import { getDb } from '../db/client.js';
import { passwordResets, users } from '../db/schema.js';
import { hashPassword } from '../lib/auth.js';
import { escapeHtml, sendEmail } from '../lib/email.js';
import { AppError } from '../lib/errors.js';
import { assertNotLimited, clearAttempts, clientIp, forgotLimits, loginLimits, recordAttempt, resetLimits } from '../lib/throttle.js';

export const passwordRoutes = new Hono();

const RESET_TTL_MIN = 60;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Demo logins (@agenda.mx) can't be reset: that domain isn't ours, so a reset email could reach
 * a stranger. The nightly demo reset restores their password anyway.
 */
const isDemoEmail = (email: string) => email.endsWith('@agenda.mx');

const COPY = {
  es: {
    subject: 'Restablece tu contraseña de Agenda',
    hello: (name: string) => `Hola ${name}:`,
    body: 'Recibimos una solicitud para restablecer tu contraseña. Abre este enlace para elegir una nueva (vence en 1 hora):',
    button: 'Elegir nueva contraseña',
    ignore: 'Si no fuiste tú, ignora este correo: tu contraseña no cambia.',
  },
  en: {
    subject: 'Reset your Agenda password',
    hello: (name: string) => `Hi ${name},`,
    body: 'We received a request to reset your password. Open this link to choose a new one (it expires in 1 hour):',
    button: 'Choose a new password',
    ignore: "If it wasn't you, ignore this email: your password stays the same.",
  },
} as const;

function appUrl(requestUrl: string): string {
  return (process.env.APP_URL ?? new URL(requestUrl).origin).replace(/\/$/, '');
}

passwordRoutes.post('/auth/forgot-password', async (c) => {
  const input = forgotPasswordSchema.parse(await c.req.json());
  const db = getDb();
  const limits = forgotLimits(clientIp(c), input.email);
  await assertNotLimited(db, limits);
  await recordAttempt(db, limits);

  const user = await db.query.users.findFirst({ where: eq(users.email, input.email) });
  if (user && !isDemoEmail(input.email)) {
    const token = randomBytes(32).toString('base64url');
    await db.delete(passwordResets).where(eq(passwordResets.userId, user.id));
    await db.insert(passwordResets).values({
      userId: user.id,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + RESET_TTL_MIN * 60_000),
    });
    const link = `${appUrl(c.req.url)}/restablecer?token=${token}`;
    const t = COPY[input.locale];
    await sendEmail({
      to: user.email,
      subject: t.subject,
      text: `${t.hello(user.name)}\n\n${t.body}\n${link}\n\n${t.ignore}`,
      html: `<p>${escapeHtml(t.hello(user.name))}</p><p>${escapeHtml(t.body)}</p>
<p><a href="${link}" style="display:inline-block;padding:10px 16px;background:#0f766e;color:#fff;border-radius:8px;text-decoration:none">${escapeHtml(t.button)}</a></p>
<p style="color:#64748b;font-size:13px">${escapeHtml(t.ignore)}</p>`,
    });
  }
  // Same answer either way, so nobody can find out which emails have an account.
  return c.json({ ok: true });
});

passwordRoutes.post('/auth/reset-password', async (c) => {
  const input = resetPasswordSchema.parse(await c.req.json());
  const db = getDb();
  const ip = clientIp(c);
  await assertNotLimited(db, resetLimits(ip));

  const row = await db.query.passwordResets.findFirst({ where: eq(passwordResets.tokenHash, sha256(input.token)) });
  if (!row || row.expiresAt < new Date()) {
    await recordAttempt(db, resetLimits(ip));
    throw new AppError(422, 'invalid_reset_token', 'This link is invalid or has expired');
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
  if (!user) throw new AppError(422, 'invalid_reset_token', 'This link is invalid or has expired');

  const passwordHash = await hashPassword(input.password);
  await db.transaction(async (tx) => {
    // Signs out every open session and burns all reset links of this person.
    await tx.update(users).set({ passwordHash, passwordChangedAt: new Date(), updatedAt: new Date() }).where(eq(users.id, user.id));
    await tx.delete(passwordResets).where(eq(passwordResets.userId, user.id));
  });
  // A locked-out person can sign in right away with the new password.
  await clearAttempts(db, [loginLimits(ip, user.email)[0]!.key, `login-email:${user.email}`]);
  return c.json({ ok: true });
});
