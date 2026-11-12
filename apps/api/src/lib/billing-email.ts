import { and, eq } from 'drizzle-orm';
import type { PlanId } from '@agenda/shared';
import type { Db } from '../db/client.js';
import { memberships, tenants, users } from '../db/schema.js';
import { escapeHtml, sendEmail } from './email.js';

/** Plan confirmation emails to the business owner (Stripe sends the payment receipt itself). */
export type BillingNotice =
  | { kind: 'activated'; plan: PlanId; amountCents: number | null; extraBusiness?: boolean }
  | { kind: 'locations'; extraLocations: number; amountCents: number; added: boolean }
  | { kind: 'changed'; plan: PlanId; amountCents: number | null }
  | { kind: 'cancelled' }
  | { kind: 'past_due' };

const PLAN_NAMES: Record<string, string> = { free: 'Gratis', individual: 'Individual', standard: 'Estándar', premium: 'Premium' };
const money = (cents: number) => `$${(cents / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MXN`;

export function billingNoticeText(business: string, n: BillingNotice, appUrl: string): { subject: string; lines: string[] } {
  const link = `${appUrl}/settings?tab=plan`;
  const amount = 'amountCents' in n && n.amountCents ? ` Se cobrarán ${money(n.amountCents)} al mes (IVA incluido).` : '';
  switch (n.kind) {
    case 'activated':
      if (n.extraBusiness)
        return {
          subject: `Tu negocio adicional está activo · ${business}`,
          lines: [`¡Gracias! Recibimos tu pago y ${business} ya está activo como negocio adicional.${amount}`, `Stripe te envía el recibo por separado. Puedes ver tus facturas o cambiar tu tarjeta en ${link}`],
        };
      return {
        subject: `Tu plan ${PLAN_NAMES[n.plan] ?? n.plan} está activo · ${business}`,
        lines: [`¡Gracias! Recibimos tu pago y el plan ${PLAN_NAMES[n.plan] ?? n.plan} de ${business} ya está activo.${amount}`, `Stripe te envía el recibo por separado. Puedes ver tus facturas o cambiar tu tarjeta en ${link}`],
      };
    case 'changed':
      return {
        subject: `Cambiaste al plan ${PLAN_NAMES[n.plan] ?? n.plan} · ${business}`,
        lines: [`${business} ahora tiene el plan ${PLAN_NAMES[n.plan] ?? n.plan}.${amount}`, `La diferencia de este mes se cobra (o se abona) de forma proporcional. Detalles en ${link}`],
      };
    case 'locations':
      return {
        subject: `${n.added ? 'Agregaste una sucursal' : 'Cerraste una sucursal'} · ${business}`,
        lines: [
          `${business} ahora tiene ${n.extraLocations} ${n.extraLocations === 1 ? 'sucursal adicional' : 'sucursales adicionales'} en su plan. Se cobrarán ${money(n.amountCents)} al mes (IVA incluido).`,
          `${n.added ? 'Hoy se cobra la parte proporcional de este mes.' : 'La parte no usada de este mes queda a tu favor.'} Detalles en ${link}`,
        ],
      };
    case 'cancelled':
      return {
        subject: `Tu suscripción se canceló · ${business}`,
        lines: [`La suscripción de ${business} se canceló y el negocio pasó al plan Gratis. No se harán más cargos.`, `Puedes volver a un plan de pago cuando quieras en ${link}`],
      };
    case 'past_due':
      return {
        subject: `No pudimos cobrar tu plan · ${business}`,
        lines: [`Stripe no pudo cobrar la suscripción de ${business}. Actualiza tu tarjeta para no perder acceso: después de 7 días la cuenta queda en solo lectura.`, `Actualizar tarjeta: ${link}`],
      };
  }
}

export async function notifyBilling(db: Db, tenantId: string, notice: BillingNotice): Promise<void> {
  try {
    const [row] = await db
      .select({ email: users.email, business: tenants.name })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(and(eq(memberships.tenantId, tenantId), eq(memberships.role, 'owner')))
      .limit(1);
    if (!row) return;
    const appUrl = (process.env.APP_URL ?? 'https://www.lugali.com').replace(/\/$/, '');
    const { subject, lines } = billingNoticeText(row.business, notice, appUrl);
    await sendEmail({
      to: row.email,
      subject,
      text: lines.join('\n\n'),
      html: `<div style="font-family:system-ui,sans-serif;max-width:520px">${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}<p style="color:#64748b;font-size:12px">Lugali</p></div>`,
    });
  } catch (e) {
    console.warn('[billing] notice failed:', e);
  }
}
