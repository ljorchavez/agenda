import { and, eq } from 'drizzle-orm';
import type { PlanId } from '@agenda/shared';
import type { Db } from '../db/client.js';
import { memberships, tenants, users } from '../db/schema.js';
import { sendEmail } from './email.js';
import { appBaseUrl, renderEmail, type EmailBlock } from './email-layout.js';

/** Plan confirmation emails to the business owner (Stripe sends the payment receipt itself). */
export type BillingNotice =
  | { kind: 'activated'; plan: PlanId; amountCents: number | null; extraBusiness?: boolean }
  | { kind: 'locations'; extraLocations: number; amountCents: number; added: boolean }
  | { kind: 'changed'; plan: PlanId; amountCents: number | null }
  | { kind: 'cancelled' }
  | { kind: 'past_due' };

const PLAN_NAMES: Record<string, string> = { free: 'Gratis', individual: 'Individual', standard: 'Estándar', premium: 'Premium' };
const money = (cents: number) => `$${(cents / 100).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} MXN`;
const planName = (p: string) => PLAN_NAMES[p] ?? p;

/** The email for one billing change: subject, plain text and the designed HTML. */
export function billingEmail(business: string, n: BillingNotice, appUrl = appBaseUrl()): { subject: string; text: string; html: string } {
  const link = `${appUrl}/settings?tab=plan`;
  const monthly = (cents: number | null) => (cents ? { label: 'Cargo mensual', value: money(cents), caption: 'IVA incluido · se cobra cada mes a tu tarjeta' } : undefined);
  let subject: string;
  let block: EmailBlock;
  switch (n.kind) {
    case 'activated':
      subject = n.extraBusiness ? `Tu negocio adicional está activo · ${business}` : `Tu plan ${planName(n.plan)} está activo · ${business}`;
      block = {
        preheader: n.amountCents ? `Pago recibido. Cargo mensual: ${money(n.amountCents)}.` : 'Pago recibido.',
        badge: { text: 'Pago recibido', tone: 'success' },
        title: n.extraBusiness ? `¡${business} ya está activo!` : `¡Tu plan ${planName(n.plan)} está activo!`,
        intro: [n.extraBusiness ? `Gracias. Recibimos tu pago y ${business} ya funciona como negocio adicional de tu cuenta.` : `Gracias. Recibimos tu pago y ${business} ya tiene todo lo del plan ${planName(n.plan)}.`],
        highlight: monthly(n.amountCents),
        details: [
          { label: 'Negocio', value: business },
          { label: 'Plan', value: n.extraBusiness ? 'Negocio adicional' : planName(n.plan), strong: true },
          { label: 'Forma de pago', value: 'Tarjeta (Stripe)' },
        ],
        button: { label: 'Ver mi plan', href: link },
        outro: ['Stripe te envía el recibo de pago por separado. Desde tu plan puedes ver tus facturas o cambiar tu tarjeta.'],
      };
      break;
    case 'changed':
      subject = `Cambiaste al plan ${planName(n.plan)} · ${business}`;
      block = {
        preheader: `${business} ahora tiene el plan ${planName(n.plan)}.`,
        badge: { text: 'Plan actualizado', tone: 'info' },
        title: `Ahora tienes el plan ${planName(n.plan)}`,
        intro: [`Hicimos el cambio de plan de ${business}. Ya puedes usar todo lo que incluye.`],
        highlight: monthly(n.amountCents),
        details: [
          { label: 'Negocio', value: business },
          { label: 'Nuevo plan', value: planName(n.plan), strong: true },
          { label: 'Este mes', value: 'Diferencia proporcional' },
        ],
        button: { label: 'Ver detalles', href: link },
        outro: ['Si subiste de plan, hoy se cobró la diferencia de los días que faltan del mes. Si bajaste, el saldo queda a tu favor para tu siguiente pago.'],
      };
      break;
    case 'locations':
      subject = `${n.added ? 'Agregaste una sucursal' : 'Cerraste una sucursal'} · ${business}`;
      block = {
        preheader: `Tu nuevo cargo mensual es de ${money(n.amountCents)}.`,
        badge: { text: n.added ? 'Sucursal agregada' : 'Sucursal cerrada', tone: 'info' },
        title: n.added ? 'Agregaste una sucursal' : 'Cerraste una sucursal',
        intro: [`${business} ahora tiene ${n.extraLocations} ${n.extraLocations === 1 ? 'sucursal adicional' : 'sucursales adicionales'} en su plan.`],
        highlight: monthly(n.amountCents),
        details: [
          { label: 'Negocio', value: business },
          { label: 'Sucursales adicionales', value: String(n.extraLocations), strong: true },
          { label: 'Este mes', value: n.added ? 'Cobro proporcional' : 'Saldo a tu favor' },
        ],
        button: { label: 'Ver mi plan', href: link },
        outro: [n.added ? 'Hoy se cobra solo la parte proporcional de los días que faltan del mes.' : 'La parte no usada de este mes queda a tu favor para tu siguiente pago.'],
      };
      break;
    case 'cancelled':
      subject = `Tu suscripción se canceló · ${business}`;
      block = {
        preheader: 'No se harán más cargos a tu tarjeta.',
        badge: { text: 'Suscripción cancelada', tone: 'neutral' },
        title: 'Tu suscripción se canceló',
        intro: [`${business} pasó al plan Gratis y no se harán más cargos a tu tarjeta.`, 'Tu información sigue guardada. Si tienes más clientes o sucursales de las que permite el plan Gratis, solo podrás consultarlas.'],
        details: [
          { label: 'Negocio', value: business },
          { label: 'Plan actual', value: 'Gratis', strong: true },
          { label: 'Próximo cargo', value: 'Ninguno' },
        ],
        button: { label: 'Volver a un plan de pago', href: link },
      };
      break;
    case 'past_due':
      subject = `No pudimos cobrar tu plan · ${business}`;
      block = {
        preheader: 'Actualiza tu tarjeta para no perder acceso.',
        badge: { text: 'Pago pendiente', tone: 'warning' },
        title: 'No pudimos cobrar tu plan',
        intro: [`Stripe no pudo cobrar la suscripción de ${business}. Puede ser una tarjeta vencida, sin fondos o un cargo rechazado por el banco.`],
        details: [
          { label: 'Negocio', value: business },
          { label: 'Qué pasa ahora', value: 'Stripe reintentará el cobro' },
          { label: 'Si no se resuelve', value: 'Solo lectura en 7 días', strong: true },
        ],
        button: { label: 'Actualizar mi tarjeta', href: link },
        outro: ['Tus citas y clientes siguen seguros. Al pagar, todo vuelve a la normalidad al instante.'],
      };
      break;
  }
  const text = [
    block.title,
    '',
    ...(block.intro ?? []),
    ...(block.highlight ? ['', `${block.highlight.label}: ${block.highlight.value} (IVA incluido)`] : []),
    '',
    ...(block.details ?? []).map((d) => `${d.label}: ${d.value}`),
    '',
    ...(block.outro ?? []),
    '',
    `${block.button!.label}: ${link}`,
    '',
    '— Lugali',
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n');
  return { subject, text, html: renderEmail(block) };
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
    await sendEmail({ to: row.email, ...billingEmail(row.business, notice) });
  } catch (e) {
    console.warn('[billing] notice failed:', e);
  }
}
