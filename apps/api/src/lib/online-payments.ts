import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { OnlinePurchase } from '@agenda/shared';
import { payments, type Tenant } from '../db/schema.js';
import { createCardCheckout, createSpeiOrder } from '../integrations/mercadopago.js';
import { decryptSecret } from './crypto.js';
import { AppError } from './errors.js';

/** The business's own Mercado Pago token, or null if it hasn't connected one. */
export function tenantMpToken(tenant: Pick<Tenant, 'mpAccessTokenEnc'>): string | null {
  if (!tenant.mpAccessTokenEnc) return null;
  try {
    return decryptSecret(tenant.mpAccessTokenEnc);
  } catch {
    return null;
  }
}

export function apiBaseUrl(requestUrl: string): string {
  return process.env.PUBLIC_API_URL ?? `${new URL(requestUrl).origin}/api`;
}

/** The app's address (for links the customer opens). */
export const appBaseUrl = (apiBase: string) => (process.env.APP_URL ?? apiBase.replace(/\/api$/, '')).replace(/\/$/, '');

/**
 * Creates a pending payment and a Mercado Pago checkout (card) or SPEI order for it.
 * Money goes to the business's own Mercado Pago account.
 */
export async function createOnlinePayment(
  db: Db,
  tenant: Tenant,
  p: {
    /** Deposit for a booking; null for an online sale (then `purchase` says what it buys) */
    appointmentId: string | null;
    purchase?: OnlinePurchase;
    notes?: string;
    locationId?: string | null;
    /** Where Mercado Pago sends the buyer back (default: the booking page) */
    backUrl?: string | ((paymentId: string) => string);
    customerId: string;
    customerEmail: string | null;
    title: string;
    amountCents: number;
    method: 'mercadopago' | 'spei';
    apiBase: string;
  },
) {
  const accessToken = tenantMpToken(tenant);
  if (!accessToken) {
    throw new AppError(422, 'mercadopago_not_configured', 'Mercado Pago is not connected');
  }

  const [pending] = await db
    .insert(payments)
    .values({
      tenantId: tenant.id,
      customerId: p.customerId,
      appointmentId: p.appointmentId,
      amountCents: p.amountCents,
      method: p.method,
      status: 'pending',
      provider: 'mercadopago',
      notes: p.notes ?? 'Anticipo',
      purchase: p.purchase ?? null,
      locationId: p.locationId ?? null,
    })
    .returning();

  const params = {
    paymentId: pending!.id,
    title: p.title,
    amountCents: p.amountCents,
    payerEmail: p.customerEmail,
    // The tenant id lets the webhook query Mercado Pago with the right account's token.
    notificationUrl: `${p.apiBase}/webhooks/mercadopago?tenant=${tenant.id}`,
    backUrl: typeof p.backUrl === 'function' ? p.backUrl(pending!.id) : (p.backUrl ?? `${appBaseUrl(p.apiBase)}/b/${tenant.slug}`),
    accessToken,
  };

  try {
    const result =
      p.method === 'spei' ? await createSpeiOrder(params) : await createCardCheckout(params);
    const [row] = await db
      .update(payments)
      .set({ providerRef: result.providerRef, checkoutUrl: result.checkoutUrl })
      .where(eq(payments.id, pending!.id))
      .returning();
    return row!;
  } catch (err) {
    await db.update(payments).set({ status: 'failed' }).where(eq(payments.id, pending!.id));
    throw err;
  }
}
