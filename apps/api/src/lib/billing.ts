import { eq, isNotNull, sql } from 'drizzle-orm';
import { ADDON_PRICES, BILLING_GRACE_DAYS, PLAN_LIMITS, withIva, type BillingStatus, type PlanId } from '@agenda/shared';
import type { Db } from '../db/client.js';
import { tenants } from '../db/schema.js';
import { AppError } from './errors.js';

/**
 * Subscription billing: each business pays its plan every month with a card, to Lugali's own
 * Mercado Pago account (Suscripciones / preapproval). Mercado Pago charges the card monthly and
 * retries failed charges; we learn about it from the webhook (/api/webhooks/billing) and a daily
 * check. See docs/billing.md.
 *
 * Env: MERCADOPAGO_BILLING_ACCESS_TOKEN (Lugali's account, not the businesses' tokens) and
 * MERCADOPAGO_BILLING_WEBHOOK_SECRET. Without the token, plan changes apply without a charge.
 */

export type SubscriptionStatus = 'pending' | 'authorized' | 'paused' | 'cancelled';

export interface Subscription {
  id: string;
  status: SubscriptionStatus;
  /** "<tenantId>|<plan>" */
  externalReference: string | null;
  amountCents: number | null;
}

export interface BillingProvider {
  name: 'mercadopago';
  /** Creates the monthly subscription; the owner enters the card on `checkoutUrl`. */
  createSubscription(o: { tenantId: string; plan: PlanId; amountCents: number; email: string; reason: string; returnUrl: string }): Promise<{ id: string; checkoutUrl: string }>;
  getSubscription(id: string): Promise<Subscription>;
  /** New monthly amount (plan change, extra locations); applies from the next charge. */
  updateAmount(id: string, amountCents: number): Promise<void>;
  cancel(id: string): Promise<void>;
  /** One monthly charge of a subscription. */
  getCharge(id: string): Promise<{ subscriptionId: string | null; approved: boolean; rejected: boolean }>;
  /** Where the payer changes the card or sees the charges. */
  manageUrl: string;
}

// ---------- Mercado Pago ----------

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
/** Tests swap the HTTP transport. */
export const setBillingFetch = (f: Fetch | null) => {
  fetchImpl = f ?? ((...a) => fetch(...a));
};

const MP = 'https://api.mercadopago.com';
const billingToken = () => process.env.MERCADOPAGO_BILLING_ACCESS_TOKEN?.trim() || null;

async function mp<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetchImpl(`${MP}${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${billingToken()}`, 'Content-Type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new AppError(502, 'billing_provider_error', json.message ?? `Mercado Pago HTTP ${res.status}`);
  return json;
}

const pesos = (cents: number) => Math.round(cents) / 100;

interface MpPreapproval {
  id: string;
  status: string;
  init_point?: string;
  external_reference?: string | null;
  auto_recurring?: { transaction_amount?: number };
}

function toSubscription(p: MpPreapproval): Subscription {
  const status: SubscriptionStatus = p.status === 'authorized' ? 'authorized' : p.status === 'paused' ? 'paused' : p.status === 'cancelled' ? 'cancelled' : 'pending';
  const amount = p.auto_recurring?.transaction_amount;
  return { id: p.id, status, externalReference: p.external_reference ?? null, amountCents: amount == null ? null : Math.round(amount * 100) };
}

const mercadoPagoBilling: BillingProvider = {
  name: 'mercadopago',
  async createSubscription(o) {
    const p = await mp<MpPreapproval>('/preapproval', {
      method: 'POST',
      body: {
        reason: o.reason,
        external_reference: `${o.tenantId}|${o.plan}`,
        payer_email: o.email,
        back_url: o.returnUrl,
        status: 'pending',
        auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: pesos(o.amountCents), currency_id: 'MXN' },
      },
    });
    if (!p.init_point) throw new AppError(502, 'billing_provider_error', 'Mercado Pago did not return a checkout link');
    return { id: p.id, checkoutUrl: p.init_point };
  },
  async getSubscription(id) {
    return toSubscription(await mp<MpPreapproval>(`/preapproval/${encodeURIComponent(id)}`));
  },
  async updateAmount(id, amountCents) {
    await mp(`/preapproval/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: { auto_recurring: { transaction_amount: pesos(amountCents), currency_id: 'MXN' } },
    });
  },
  async cancel(id) {
    await mp(`/preapproval/${encodeURIComponent(id)}`, { method: 'PUT', body: { status: 'cancelled' } });
  },
  async getCharge(id) {
    const r = await mp<{ preapproval_id?: string; status?: string; payment?: { status?: string } }>(`/authorized_payments/${encodeURIComponent(id)}`);
    const pay = r.payment?.status;
    return {
      subscriptionId: r.preapproval_id ?? null,
      approved: pay === 'approved' || r.status === 'processed',
      rejected: pay === 'rejected' || r.status === 'recycling',
    };
  },
  manageUrl: 'https://www.mercadopago.com.mx/subscriptions',
};

/** The configured provider, or null while card billing isn't connected yet. */
export function billingProvider(): BillingProvider | null {
  return billingToken() ? mercadoPagoBilling : null;
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

/** Monthly amount with IVA for `plan` given the business's extra locations / extra business. */
export async function monthlyAmountFor(db: Pick<Db, 'execute'>, tenantId: string, plan: PlanId): Promise<number | null> {
  const limits = PLAN_LIMITS[plan];
  if (plan === 'free') return 0;
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
  const base = r?.extra_business ? ADDON_PRICES.extraBusinessCents : limits.priceCents;
  if (base == null) return null;
  return withIva(base + extraLocations * ADDON_PRICES.extraLocationCents);
}

/**
 * Keeps the card charge in line with the plan and add-ons (call after a location is added or
 * removed). Never fails the caller: the daily check retries.
 */
export async function syncBillingAmount(db: Db, tenantId: string): Promise<void> {
  const provider = billingProvider();
  if (!provider) return;
  try {
    const t = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    if (!t?.billingSubscriptionId || (t.billingStatus !== 'active' && t.billingStatus !== 'past_due')) return;
    const amount = await monthlyAmountFor(db, tenantId, t.plan);
    if (amount == null || amount === t.billingAmountCents) return;
    await provider.updateAmount(t.billingSubscriptionId, amount);
    await db.update(tenants).set({ billingAmountCents: amount }).where(eq(tenants.id, tenantId));
  } catch (e) {
    console.warn('[billing] amount sync failed:', e);
  }
}

/** Applies what the provider says about a subscription (webhook and daily check). */
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
    // A newer subscription replaces an older one (plan change from scratch, card re-entered).
    if (t.billingSubscriptionId && !current && (t.billingStatus === 'active' || t.billingStatus === 'past_due')) {
      await provider.cancel(t.billingSubscriptionId).catch((e) => console.warn('[billing] cancel old failed:', e));
    }
    const plan = t.billingPendingPlan ?? (refPlan && refPlan in PLAN_LIMITS ? refPlan : t.plan);
    // A new authorization (first card, plan bought, card re-entered) settles any unpaid state;
    // otherwise failed charges are handled by syncCharge.
    const newAuth = !current || t.billingPendingPlan != null || t.billingStatus === 'pending' || t.billingStatus === 'cancelled';
    await db
      .update(tenants)
      .set({
        plan,
        billingSubscriptionId: sub.id,
        billingPendingPlan: null,
        billingAmountCents: sub.amountCents,
        ...(newAuth ? { billingStatus: 'active' as const, billingPastDueSince: null } : {}),
      })
      .where(eq(tenants.id, t.id));
    return;
  }
  if (!current) return;
  if (sub.status === 'paused') {
    await db
      .update(tenants)
      .set({ billingStatus: 'past_due', billingPastDueSince: t.billingPastDueSince ?? new Date() })
      .where(eq(tenants.id, t.id));
  } else if (sub.status === 'cancelled') {
    // Cancelled at Mercado Pago (by the owner or after failed retries): back to the free plan.
    await db
      .update(tenants)
      .set({ plan: t.billingStatus === 'pending' ? t.plan : 'free', billingStatus: 'cancelled', billingSubscriptionId: null, billingPendingPlan: null, billingAmountCents: null, billingPastDueSince: null })
      .where(eq(tenants.id, t.id));
  }
}

/** One monthly charge: approved clears a failure, rejected starts the grace period. */
export async function syncCharge(db: Db, chargeId: string): Promise<void> {
  const provider = billingProvider();
  if (!provider) return;
  const ch = await provider.getCharge(chargeId);
  if (!ch.subscriptionId) return;
  const t = await db.query.tenants.findFirst({ where: eq(tenants.billingSubscriptionId, ch.subscriptionId) });
  if (!t) return;
  if (ch.approved) {
    await db.update(tenants).set({ billingStatus: 'active', billingPastDueSince: null }).where(eq(tenants.id, t.id));
  } else if (ch.rejected && t.billingStatus !== 'past_due') {
    await db.update(tenants).set({ billingStatus: 'past_due', billingPastDueSince: new Date() }).where(eq(tenants.id, t.id));
  }
}

/** Daily: re-reads every open subscription in case a webhook was missed. */
export async function reconcileBilling(db: Db): Promise<number> {
  if (!billingProvider()) return 0;
  const rows = await db.select({ id: tenants.billingSubscriptionId }).from(tenants).where(isNotNull(tenants.billingSubscriptionId));
  let n = 0;
  for (const r of rows) {
    try {
      await syncSubscription(db, r.id!);
      n++;
    } catch (e) {
      console.warn('[billing] reconcile failed:', e);
    }
  }
  return n;
}
