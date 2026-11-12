import crypto from 'node:crypto';
import { and, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { ADDON_PRICES, BILLING_GRACE_DAYS, PLAN_LIMITS, withIva, type BillingStatus, type PlanId } from '@agenda/shared';
import type { Db } from '../db/client.js';
import { tenants } from '../db/schema.js';
import { AppError } from './errors.js';
import { notifyBilling } from './billing-email.js';

/**
 * Subscription billing: each business pays Lugali its plan every month with a card through
 * Stripe (Checkout to subscribe, Customer Portal to change the card or cancel). Plan changes and
 * extra locations update the subscription with proration. Stripe tells us what happened through
 * the webhook (/api/webhooks/billing); a daily check re-reads every subscription. See docs/billing.md.
 *
 * Businesses charge THEIR customers with Mercado Pago (integrations/mercadopago.ts); this is only
 * what Lugali charges the businesses.
 *
 * Env: STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET. Without the key, plan changes apply without a charge.
 */

export type SubscriptionStatus = 'pending' | 'authorized' | 'paused' | 'cancelled';

export interface Subscription {
  id: string;
  status: SubscriptionStatus;
  /** "<tenantId>|<plan>" */
  externalReference: string | null;
  amountCents: number | null;
}

/** What a business pays each month: its plan (or the extra-business price) plus extra locations. */
export interface BillingLines {
  plan: PlanId;
  /** Lookup key and price (IVA included) of the main line */
  base: { key: string; name: string; amountCents: number };
  extraLocations: number;
  extraLocationCents: number;
  totalCents: number;
}

export interface BillingProvider {
  name: 'stripe';
  /** Checkout page where the owner enters the card; the subscription exists once it's paid. */
  createSubscription(o: { tenantId: string; lines: BillingLines; email: string; returnUrl: string; cancelUrl: string }): Promise<{ id: string; checkoutUrl: string }>;
  getSubscription(id: string): Promise<Subscription>;
  /** New plan / number of extra locations; charged right away, prorated. */
  update(id: string, lines: BillingLines): Promise<void>;
  cancel(id: string): Promise<void>;
  /** Stripe's page to change the card, see invoices or cancel. */
  portalUrl(subscriptionId: string, returnUrl: string): Promise<string>;
  /** Who paid a checkout and which subscription it created (null while unpaid). */
  checkoutSession(id: string): Promise<{ tenantId: string | null; subscriptionId: string | null }>;
}

// ---------- Stripe ----------

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
/** Tests swap the HTTP transport. */
export const setBillingFetch = (f: Fetch | null) => {
  fetchImpl = f ?? ((...a) => fetch(...a));
};

const STRIPE = 'https://api.stripe.com/v1';
const stripeKey = () => process.env.STRIPE_SECRET_KEY?.trim() || null;

type Params = Record<string, string | number | boolean | undefined | null>;

/** Stripe takes form-encoded bodies with bracket keys (items[0][price]=...). */
function form(params: Params): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) out.append(k, String(v));
  return out.toString();
}

async function stripe<T>(path: string, init: { method?: string; params?: Params } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const body = init.params && method !== 'GET' ? form(init.params) : undefined;
  const qs = init.params && method === 'GET' ? `?${form(init.params)}` : '';
  const res = await fetchImpl(`${STRIPE}${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${stripeKey()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) throw new AppError(502, 'billing_provider_error', json.error?.message ?? `Stripe HTTP ${res.status}`);
  return json;
}

/** Monthly price for a line, created in Stripe the first time it's needed (versioned by amount). */
async function priceId(key: string, name: string, amountCents: number): Promise<string> {
  const lookup = `lugali_${key}_${amountCents}`;
  const found = await stripe<{ data: { id: string }[] }>('/prices', { params: { 'lookup_keys[]': lookup, active: true, limit: 1 } });
  if (found.data[0]) return found.data[0].id;
  const created = await stripe<{ id: string }>('/prices', {
    method: 'POST',
    params: {
      currency: 'mxn',
      unit_amount: amountCents,
      'recurring[interval]': 'month',
      'product_data[name]': name,
      lookup_key: lookup,
      transfer_lookup_key: true,
    },
  });
  return created.id;
}

interface StripeSub {
  id: string;
  status: string;
  customer: string;
  metadata?: Record<string, string>;
  items: { data: { id: string; quantity?: number; price: { id: string; unit_amount: number | null; lookup_key?: string | null } }[] };
}

function toSubscription(s: StripeSub): Subscription {
  const status: SubscriptionStatus =
    s.status === 'active' || s.status === 'trialing'
      ? 'authorized'
      : s.status === 'past_due' || s.status === 'unpaid' || s.status === 'paused'
        ? 'paused'
        : s.status === 'canceled' || s.status === 'incomplete_expired'
          ? 'cancelled'
          : 'pending';
  const amount = s.items.data.reduce((sum, i) => sum + (i.price.unit_amount ?? 0) * (i.quantity ?? 1), 0);
  const tenantId = s.metadata?.tenantId;
  return { id: s.id, status, externalReference: tenantId ? `${tenantId}|${s.metadata?.plan ?? ''}` : null, amountCents: amount };
}

const isLocationItem = (i: StripeSub['items']['data'][number]) => (i.price.lookup_key ?? '').startsWith('lugali_extra_location_');
const locationPrice = (lines: BillingLines) => priceId('extra_location', 'Lugali · Sucursal adicional', lines.extraLocationCents);

const stripeBilling: BillingProvider = {
  name: 'stripe',
  async createSubscription(o) {
    const params: Params = {
      mode: 'subscription',
      // Lets the page confirm the payment right away, without waiting for the webhook.
      success_url: `${o.returnUrl}${o.returnUrl.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: o.cancelUrl,
      customer_email: o.email,
      client_reference_id: o.tenantId,
      locale: 'es-419',
      allow_promotion_codes: true,
      'metadata[tenantId]': o.tenantId,
      'metadata[plan]': o.lines.plan,
      'subscription_data[metadata][tenantId]': o.tenantId,
      'subscription_data[metadata][plan]': o.lines.plan,
      'line_items[0][price]': await priceId(o.lines.base.key, o.lines.base.name, o.lines.base.amountCents),
      'line_items[0][quantity]': 1,
    };
    if (o.lines.extraLocations > 0) {
      params['line_items[1][price]'] = await locationPrice(o.lines);
      params['line_items[1][quantity]'] = o.lines.extraLocations;
    }
    const s = await stripe<{ id: string; url?: string }>('/checkout/sessions', { method: 'POST', params });
    if (!s.url) throw new AppError(502, 'billing_provider_error', 'Stripe did not return a checkout link');
    return { id: s.id, checkoutUrl: s.url };
  },
  async getSubscription(id) {
    return toSubscription(await stripe<StripeSub>(`/subscriptions/${encodeURIComponent(id)}`));
  },
  async update(id, lines) {
    const s = await stripe<StripeSub>(`/subscriptions/${encodeURIComponent(id)}`);
    const main = s.items.data.find((i) => !isLocationItem(i));
    const loc = s.items.data.find(isLocationItem);
    const params: Params = {
      proration_behavior: 'always_invoice',
      'metadata[plan]': lines.plan,
      'items[0][id]': main?.id,
      'items[0][price]': await priceId(lines.base.key, lines.base.name, lines.base.amountCents),
      'items[0][quantity]': 1,
    };
    if (lines.extraLocations > 0) {
      params['items[1][id]'] = loc?.id;
      params['items[1][price]'] = await locationPrice(lines);
      params['items[1][quantity]'] = lines.extraLocations;
    } else if (loc) {
      params['items[1][id]'] = loc.id;
      params['items[1][deleted]'] = true;
    }
    await stripe(`/subscriptions/${encodeURIComponent(id)}`, { method: 'POST', params });
  },
  async cancel(id) {
    // A checkout that was never paid just expires; a real subscription is cancelled now.
    if (id.startsWith('cs_')) await stripe(`/checkout/sessions/${encodeURIComponent(id)}/expire`, { method: 'POST', params: {} });
    else await stripe(`/subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  async checkoutSession(id) {
    const s = await stripe<{ client_reference_id?: string | null; subscription?: string | null }>(`/checkout/sessions/${encodeURIComponent(id)}`);
    return { tenantId: s.client_reference_id ?? null, subscriptionId: s.subscription ?? null };
  },
  async portalUrl(subscriptionId, returnUrl) {
    const s = await stripe<StripeSub>(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
    const p = await stripe<{ url: string }>('/billing_portal/sessions', { method: 'POST', params: { customer: s.customer, return_url: returnUrl, locale: 'es-419' } });
    return p.url;
  },
};

/** The configured provider, or null while card billing isn't connected yet. */
export function billingProvider(): BillingProvider | null {
  return stripeKey() ? stripeBilling : null;
}

/**
 * Stripe-Signature check: HMAC-SHA256 of "<t>.<raw body>" with STRIPE_WEBHOOK_SECRET, within 5 min.
 * Without the secret it only passes outside production.
 */
export function verifyStripeSignature(raw: string, header: string | undefined, now = Date.now()): boolean {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== 'production';
  if (!header) return false;
  const items = header.split(',').map((p) => p.trim());
  const t = Number(items.find((p) => p.startsWith('t='))?.slice(2));
  const sigs = items.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

/** Subscription id an event is about (subscription, checkout or invoice events). */
export function subscriptionIdOf(event: { type?: string; data?: { object?: Record<string, unknown> } }): string | null {
  const o = event.data?.object ?? {};
  if (typeof event.type === 'string' && event.type.startsWith('customer.subscription.')) return typeof o.id === 'string' ? o.id : null;
  if (typeof o.subscription === 'string') return o.subscription;
  const parent = o.parent as { subscription_details?: { subscription?: string } } | undefined;
  return parent?.subscription_details?.subscription ?? null;
}

// ---------- State ----------

/**
 * A failed charge older than the grace period. (An extra business opened while card billing is on
 * starts "past due" since 1970, so it's read-only until its subscription is paid.)
 */
export function isReadOnly(t: { billingStatus: BillingStatus; billingPastDueSince: Date | null }): boolean {
  if (t.billingStatus === 'past_due' && t.billingPastDueSince) {
    return Date.now() - t.billingPastDueSince.getTime() > BILLING_GRACE_DAYS * 86_400_000;
  }
  return false;
}

/** Demo businesses are never charged. */
export const isDemoSlug = (slug: string) => slug.endsWith('-demo');

const PLAN_NAMES: Record<PlanId, string> = { free: 'Gratis', individual: 'Individual', standard: 'Estándar', premium: 'Premium' };

/** The lines a business pays for `plan` (null for Gratis or a plan without a price). */
export async function billingLinesFor(db: Pick<Db, 'execute'>, tenantId: string, plan: PlanId): Promise<BillingLines | null> {
  if (plan === 'free') return null;
  const limits = PLAN_LIMITS[plan];
  const res = await db.execute<{ locations: string; extra_business: boolean }>(sql`
    select (select count(*) from locations where tenant_id = ${tenantId} and active) as locations,
           exists (
             select 1 from memberships m
             join memberships o on o.user_id = m.user_id and o.role = 'owner'
             join tenants t on t.id = o.tenant_id
             where m.tenant_id = ${tenantId} and m.role = 'owner'
               and t.created_at < (select created_at from tenants where id = ${tenantId})) as extra_business`);
  const r = res.rows[0];
  const extraLocations = limits.extraLocations ? Math.max(0, Number(r?.locations ?? 0) - limits.includedLocations) : 0;
  const extraBusiness = Boolean(r?.extra_business);
  const baseCents = extraBusiness ? ADDON_PRICES.extraBusinessCents : limits.priceCents;
  if (baseCents == null) return null;
  const base = extraBusiness
    ? { key: 'extra_business', name: 'Lugali · Negocio adicional', amountCents: withIva(baseCents) }
    : { key: plan, name: `Lugali · Plan ${PLAN_NAMES[plan]}`, amountCents: withIva(baseCents) };
  const extraLocationCents = withIva(ADDON_PRICES.extraLocationCents);
  return { plan, base, extraLocations, extraLocationCents, totalCents: base.amountCents + extraLocations * extraLocationCents };
}

/**
 * Keeps the subscription in line with the plan and extra locations (call after a location is
 * added or removed): Stripe charges the difference right away. Never fails the caller.
 */
export async function syncBillingAmount(db: Db, tenantId: string): Promise<void> {
  const provider = billingProvider();
  if (!provider) return;
  try {
    const t = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    if (!t?.billingSubscriptionId || (t.billingStatus !== 'active' && t.billingStatus !== 'past_due')) return;
    const lines = await billingLinesFor(db, tenantId, t.plan);
    if (!lines || lines.totalCents === t.billingAmountCents) return;
    await provider.update(t.billingSubscriptionId, lines);
    await db.update(tenants).set({ billingAmountCents: lines.totalCents }).where(eq(tenants.id, tenantId));
  } catch (e) {
    console.warn('[billing] amount sync failed:', e);
  }
}

/** Applies what Stripe says about a subscription (webhook and daily check). */
export async function syncSubscription(db: Db, subscriptionId: string): Promise<void> {
  const provider = billingProvider();
  if (!provider) return;
  const sub = await provider.getSubscription(subscriptionId);
  const [tenantId, refPlan] = (sub.externalReference ?? '').split('|') as [string?, PlanId?];
  if (!tenantId || !/^[0-9a-f-]{36}$/.test(tenantId)) return;
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  if (!t) return;
  const current = t.billingSubscriptionId === sub.id;

  if (sub.status === 'authorized') {
    // A newer subscription replaces an older one (paid again after cancelling, card re-entered).
    if (t.billingSubscriptionId && !current && !t.billingSubscriptionId.startsWith('cs_') && (t.billingStatus === 'active' || t.billingStatus === 'past_due')) {
      await provider.cancel(t.billingSubscriptionId).catch((e) => console.warn('[billing] cancel old failed:', e));
    }
    const plan = (refPlan && refPlan in PLAN_LIMITS ? refPlan : null) ?? t.billingPendingPlan ?? t.plan;
    // Only one confirmation email: whoever (webhook or the return page) claims the change first.
    const claimed = await db
      .update(tenants)
      .set({ plan, billingStatus: 'active', billingSubscriptionId: sub.id, billingPendingPlan: null, billingAmountCents: sub.amountCents, billingPastDueSince: null })
      .where(and(eq(tenants.id, t.id), or(ne(tenants.billingStatus, 'active'), ne(tenants.billingSubscriptionId, sub.id), isNull(tenants.billingSubscriptionId))))
      .returning({ id: tenants.id });
    if (claimed.length) await notifyBilling(db, t.id, { kind: 'activated', plan, amountCents: sub.amountCents });
    else await db.update(tenants).set({ billingAmountCents: sub.amountCents }).where(eq(tenants.id, t.id));
    return;
  }
  if (!current) return;
  if (sub.status === 'paused') {
    if (t.billingStatus !== 'past_due') await notifyBilling(db, t.id, { kind: 'past_due' });
    await db
      .update(tenants)
      .set({ billingStatus: 'past_due', billingPastDueSince: t.billingPastDueSince ?? new Date() })
      .where(eq(tenants.id, t.id));
  } else if (sub.status === 'cancelled') {
    // Cancelled (by the owner in Stripe or after failed retries): back to the free plan.
    await db
      .update(tenants)
      .set({ plan: 'free', billingStatus: 'cancelled', billingSubscriptionId: null, billingPendingPlan: null, billingAmountCents: null, billingPastDueSince: null })
      .where(eq(tenants.id, t.id));
    await notifyBilling(db, t.id, { kind: 'cancelled' });
  }
}

/** Daily: re-reads every subscription in case a webhook was missed. */
export async function reconcileBilling(db: Db): Promise<number> {
  if (!billingProvider()) return 0;
  const rows = await db.select({ id: tenants.billingSubscriptionId }).from(tenants).where(isNotNull(tenants.billingSubscriptionId));
  let n = 0;
  for (const r of rows) {
    if (!r.id || r.id.startsWith('cs_')) continue;
    try {
      await syncSubscription(db, r.id);
      n++;
    } catch (e) {
      console.warn('[billing] reconcile failed:', e);
    }
  }
  return n;
}
