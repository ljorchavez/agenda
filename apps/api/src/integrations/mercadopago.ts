import crypto from 'node:crypto';
import { AppError } from '../lib/errors.js';

/**
 * Mercado Pago (Mexico) client.
 * - Card / wallet: Checkout Pro preference -> `init_point` URL.
 * - SPEI: Orders API with payment_method { id: 'clabe', type: 'bank_transfer' } -> ticket_url.
 *   Docs: https://www.mercadopago.com.mx/developers/es/docs/checkout-api-orders/payment-integration/spei-transfers
 *
 * MVP uses one platform access token (MERCADOPAGO_ACCESS_TOKEN). Next phase: each tenant
 * connects its own account via OAuth and we store its access token encrypted per tenant.
 */

const API = 'https://api.mercadopago.com';

function token(): string {
  const t = process.env.MERCADOPAGO_ACCESS_TOKEN;
  if (!t) throw new AppError(422, 'mercadopago_not_configured', 'Mercado Pago is not configured');
  return t;
}

export function isMercadoPagoConfigured(): boolean {
  return Boolean(process.env.MERCADOPAGO_ACCESS_TOKEN);
}

async function mpFetch<T>(path: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      ...(init.idempotencyKey ? { 'X-Idempotency-Key': init.idempotencyKey } : {}),
    },
  });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) {
    throw new AppError(502, 'mercadopago_error', json.message ?? `Mercado Pago HTTP ${res.status}`);
  }
  return json;
}

const pesos = (cents: number) => (cents / 100).toFixed(2);

export interface CheckoutParams {
  /** Our payments.id; comes back as external_reference */
  paymentId: string;
  title: string;
  amountCents: number;
  payerEmail?: string | null;
  notificationUrl: string;
  backUrl: string;
}

export async function createCardCheckout(p: CheckoutParams) {
  const pref = await mpFetch<{ id: string; init_point: string }>('/checkout/preferences', {
    method: 'POST',
    idempotencyKey: p.paymentId,
    body: JSON.stringify({
      items: [
        { title: p.title, quantity: 1, unit_price: Number(pesos(p.amountCents)), currency_id: 'MXN' },
      ],
      external_reference: p.paymentId,
      notification_url: p.notificationUrl,
      back_urls: { success: p.backUrl, pending: p.backUrl, failure: p.backUrl },
      auto_return: 'approved',
      ...(p.payerEmail ? { payer: { email: p.payerEmail } } : {}),
    }),
  });
  return { providerRef: pref.id, checkoutUrl: pref.init_point };
}

export async function createSpeiOrder(p: CheckoutParams) {
  const amount = pesos(p.amountCents);
  const order = await mpFetch<{
    id: string;
    transactions?: {
      payments?: { payment_method?: { reference?: string; ticket_url?: string } }[];
    };
  }>('/v1/orders', {
    method: 'POST',
    idempotencyKey: p.paymentId,
    body: JSON.stringify({
      type: 'online',
      processing_mode: 'automatic',
      external_reference: p.paymentId,
      total_amount: amount,
      payer: { email: p.payerEmail || 'cliente@example.com' },
      transactions: {
        payments: [
          {
            amount,
            payment_method: { id: 'clabe', type: 'bank_transfer' },
            expiration_time: 'P3D',
          },
        ],
      },
    }),
  });
  const pm = order.transactions?.payments?.[0]?.payment_method;
  return { providerRef: order.id, checkoutUrl: pm?.ticket_url ?? null, reference: pm?.reference };
}

/** Normalized status lookup for a webhook notification. */
export async function fetchStatus(
  topic: 'payment' | 'order',
  id: string,
): Promise<{ externalReference: string | null; status: 'paid' | 'pending' | 'failed' | 'refunded' }> {
  if (topic === 'payment') {
    const p = await mpFetch<{ status: string; external_reference: string | null }>(
      `/v1/payments/${encodeURIComponent(id)}`,
    );
    return { externalReference: p.external_reference, status: mapStatus(p.status) };
  }
  const o = await mpFetch<{ status: string; external_reference: string | null }>(
    `/v1/orders/${encodeURIComponent(id)}`,
  );
  return { externalReference: o.external_reference, status: mapStatus(o.status) };
}

function mapStatus(s: string): 'paid' | 'pending' | 'failed' | 'refunded' {
  if (s === 'approved' || s === 'processed' || s === 'accredited') return 'paid';
  if (s === 'refunded' || s === 'charged_back') return 'refunded';
  if (s === 'rejected' || s === 'cancelled' || s === 'canceled' || s === 'expired') return 'failed';
  return 'pending';
}

/**
 * Validates the `x-signature` header (ts=...,v1=...) using the webhook secret.
 * Manifest: `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
 */
export function verifyMercadoPagoSignature(params: {
  signature: string | undefined;
  requestId: string | undefined;
  dataId: string;
}): boolean {
  const secret = process.env.MERCADOPAGO_WEBHOOK_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  if (!params.signature) return false;
  const parts = Object.fromEntries(
    params.signature.split(',').map((kv) => kv.trim().split('=') as [string, string]),
  );
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${params.dataId.toLowerCase()};request-id:${params.requestId ?? ''};ts:${parts.ts};`;
  const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return (
    expected.length === parts.v1.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1))
  );
}
