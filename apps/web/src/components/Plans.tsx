import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ADDON_PRICES, BILLING_GRACE_DAYS, PLAN_LIMITS, PLANS, SELECTABLE_PLANS, withIva, type PlanId, type PlanInfoDto } from '@agenda/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money } from '../lib/format';
import { ErrorText, Loading } from './ui';

/** What each plan includes, from the limits in packages/shared (one source of truth). */
function features(t: (k: string, o?: Record<string, unknown>) => string, plan: PlanId): string[] {
  const l = PLAN_LIMITS[plan];
  return [
    t('plans.oneBusiness'),
    l.includedLocations > 1 ? t('plans.locationsIncluded', { count: l.includedLocations }) : t('plans.oneLocation'),
    ...(l.maxResources != null ? [t('plans.oneAgenda')] : []),
    l.maxCustomers == null ? t('plans.unlimitedCustomers') : t('plans.maxCustomers', { count: l.maxCustomers }),
    l.maxBookingsPerMonth == null ? t('plans.unlimitedBookings') : t('plans.maxBookings', { count: l.maxBookingsPerMonth }),
    l.extraLocations ? t('plans.extrasAllowed') : t('plans.noExtras'),
    t('plans.reviewsCalendar'),
    ...(l.packages ? [t('plans.packagesIncluded')] : []),
    ...(l.records ? [t('plans.recordsIncluded', { gb: l.recordPhotosMb >= 1024 ? Math.round(l.recordPhotosMb / 1024) : l.recordPhotosMb / 1024 })] : []),
    ...(l.cash ? [t('plans.cashIncluded')] : []),
    ...(l.prioritySupport ? [t('plans.prioritySupport')] : []),
  ];
}

/** Plan cards: used to sign up and to change plan in Settings. */
export function PlanCards({ current, onPick, busy }: { current?: PlanId; onPick: (p: PlanId) => void; busy?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {PLANS.map((p) => {
        const l = PLAN_LIMITS[p];
        const available = SELECTABLE_PLANS.includes(p);
        const isCurrent = current === p;
        return (
          <div
            key={p}
            data-testid={`plan-${p}`}
            className={`flex flex-col rounded-2xl border bg-white p-5 ${p === 'standard' ? 'border-brand-600 shadow-md' : 'border-slate-200'} ${available ? '' : 'opacity-70'}`}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">{t(`plans.${p}`)}</h3>
              {p === 'standard' && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-800">{t('plans.popular')}</span>}
            </div>
            <div className="mt-2 text-2xl font-bold text-slate-900">
              {l.priceCents == null ? t('plans.soon') : l.priceCents === 0 ? t('plans.freePrice') : (
                <>
                  {money(l.priceCents)} <span className="text-sm font-normal text-slate-500">{t('plans.plusIva')} {t('plans.perMonth')}</span>
                </>
              )}
            </div>
            <ul className="mt-3 flex-1 space-y-1.5 text-sm text-slate-700">
              {features(t, p).map((f) => (
                <li key={f} className="flex gap-2"><span className="text-brand-700">✓</span>{f}</li>
              ))}
            </ul>
            <button
              type="button"
              className={`mt-4 w-full ${p === 'standard' ? 'btn-primary' : 'btn-secondary'}`}
              disabled={!available || isCurrent || busy}
              onClick={() => onPick(p)}
            >
              {isCurrent ? t('plans.current') : available ? t('plans.choose') : t('plans.soon')}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Add-on prices shown under the plans. */
export function PlanExtras() {
  const { t } = useTranslation();
  return (
    <p className="mt-3 text-sm text-slate-600">
      {t('plans.extras', { location: money(ADDON_PRICES.extraLocationCents), business: money(ADDON_PRICES.extraBusinessCents) })}
    </p>
  );
}

/** Settings → Plan: current plan, usage against its limits, and changing plan (owner). */
export function PlanSection({ canChange }: { canChange: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { setTenant, tenant } = useAuth();
  const [changing, setChanging] = useState(false);
  const [confirming, setConfirming] = useState<PlanId | null>(null);
  // Back from Stripe Checkout: confirm right away (the webhook may take a few seconds).
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
  const returning = params?.get('billing') === 'return';
  const sessionId = params?.get('session_id') ?? null;
  const [paidNotice, setPaidNotice] = useState(false);
  useEffect(() => {
    if (!returning || !sessionId) return;
    api<{ paid: boolean; plan: PlanInfoDto }>('/tenant/billing/confirm', { method: 'POST', body: { sessionId } })
      .then((r) => {
        qc.setQueryData(['plan'], r.plan);
        if (tenant) setTenant({ ...tenant, plan: r.plan.plan, billing: { ...tenant.billing, status: r.plan.billing.status, readOnly: r.plan.billing.readOnly, pastDueSince: r.plan.billing.pastDueSince } });
        setPaidNotice(r.paid);
      })
      .catch(() => undefined)
      .finally(() => window.history.replaceState(null, '', `${window.location.pathname}?tab=plan`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const info = useQuery({
    queryKey: ['plan'],
    queryFn: () => api<PlanInfoDto>('/tenant/plan'),
    refetchInterval: (q) => (returning && q.state.data?.billing.status === 'pending' ? 4000 : false),
  });
  const change = useMutation({
    mutationFn: (plan: PlanId) => api<{ checkoutUrl: string | null; plan: PlanInfoDto }>('/tenant/plan', { method: 'PUT', body: { plan } }),
    onSuccess: (r) => {
      if (r.checkoutUrl) {
        window.location.assign(r.checkoutUrl);
        return;
      }
      qc.setQueryData(['plan'], r.plan);
      if (tenant) setTenant({ ...tenant, plan: r.plan.plan });
      setChanging(false);
      setConfirming(null);
    },
  });
  const p = info.data;
  const meter = (used: number, max: number | null) => (
    <span className={max != null && used >= max ? 'font-semibold text-rose-700' : ''}>
      {max == null ? t('plans.usedUnlimited', { used }) : t('plans.used', { used, max })}
    </span>
  );
  return (
    <section className="card mt-6 space-y-3" id="plan">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{t('plans.section')}</h2>
        {canChange && p && (
          <button type="button" className="btn-secondary" onClick={() => setChanging(!changing)}>
            {changing ? t('common.cancel') : t('plans.changePlan')}
          </button>
        )}
      </div>
      {paidNotice && p && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800" role="status" data-testid="billing-paid">
          {t('billing.paidNotice', { plan: t(`plans.${p.plan}`) })}
        </div>
      )}
      {!p ? (
        <Loading />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-4" data-testid="plan-summary">
            <div className="rounded-lg bg-slate-50 p-3">
              <div className="text-xs text-slate-500">{t('plans.yourPlan')}</div>
              <div className="font-semibold">{t(`plans.${p.plan}`)}</div>
              <div className="text-xs text-slate-500">
                {p.monthlyTotalCents == null ? t('plans.soon') : p.monthlyTotalCents === 0 ? t('plans.freePrice') : `${money(p.monthlyTotalCents)} ${t('plans.plusIva')} ${t('plans.perMonth')}`}
              </div>
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <div className="text-xs text-slate-500">{t('plans.customers')}</div>
              {meter(p.usage.customers, p.limits.maxCustomers)}
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <div className="text-xs text-slate-500">{t('plans.bookingsMonth')}</div>
              {meter(p.usage.bookingsThisMonth, p.limits.maxBookingsPerMonth)}
            </div>
            <div className="rounded-lg bg-slate-50 p-3">
              <div className="text-xs text-slate-500">{t('plans.locations')}</div>
              {meter(p.usage.activeLocations, p.limits.extraLocations ? null : p.limits.includedLocations)}
              {p.extraLocations > 0 && <div className="text-xs text-slate-500">{t('plans.extraLocationsN', { count: p.extraLocations })}</div>}
            </div>
          </div>
          {p.limits.maxResources != null && (
            <p className="text-xs text-slate-500" data-testid="resource-usage">
              {t('plans.agendasUsed', { used: p.usage.activeResources, max: p.limits.maxResources })}
            </p>
          )}
          {p.limits.records && (
            <p className="text-xs text-slate-500" data-testid="photo-usage">
              {t('plans.photoUsage', { used: p.usage.recordPhotosMb, total: p.limits.recordPhotosMb >= 1024 ? `${p.limits.recordPhotosMb / 1024} GB` : `${p.limits.recordPhotosMb} MB` })}
            </p>
          )}
          {p.extraBusiness && <p className="text-xs text-slate-500">{t('plans.extraBusinessNote')}</p>}
          {!p.billingConnected && <p className="text-xs text-slate-500">{t('plans.billingSoon')}</p>}
          {p.billingConnected && <BillingStatus info={p} canChange={canChange} busy={change.isPending} pay={(x) => change.mutate(x)} returning={returning} />}
          {changing && (
            <div className="pt-2">
              {confirming ? (
                <ConfirmPlanChange info={p} plan={confirming} busy={change.isPending} onCancel={() => setConfirming(null)} onConfirm={() => change.mutate(confirming)} />
              ) : (
                <PlanCards
                  current={p.plan}
                  busy={change.isPending}
                  onPick={(x) => {
                    // Changes that charge the saved card or cancel it need an explicit yes; a new checkout is confirmed on Stripe's page.
                    const live = p.billingConnected && (p.billing.status === 'active' || p.billing.status === 'past_due');
                    if (live || (x === 'free' && p.plan !== 'free')) setConfirming(x);
                    else change.mutate(x);
                  }}
                />
              )}
              <PlanExtras />
            </div>
          )}
          <ErrorText error={change.error} />
        </>
      )}
    </section>
  );
}

/** What changes on the card before switching plan or going back to Gratis. */
function ConfirmPlanChange({ info, plan, busy, onCancel, onConfirm }: { info: PlanInfoDto; plan: PlanId; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  const l = PLAN_LIMITS[plan];
  const extra = l.extraLocations ? Math.max(0, info.usage.activeLocations - l.includedLocations) : 0;
  const base = info.extraBusiness ? ADDON_PRICES.extraBusinessCents : l.priceCents;
  const monthly = base == null ? null : withIva(base) + extra * withIva(ADDON_PRICES.extraLocationCents);
  const live = info.billingConnected && (info.billing.status === 'active' || info.billing.status === 'past_due');
  const toFree = plan === 'free';
  return (
    <div className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm" role="alertdialog" aria-labelledby="confirm-plan-title" data-testid="confirm-plan">
      <h3 id="confirm-plan-title" className="font-semibold">
        {toFree ? t('billing.confirmFreeTitle') : t('billing.confirmChangeTitle', { from: t(`plans.${info.plan}`), to: t(`plans.${plan}`) })}
      </h3>
      {toFree ? (
        <p>{live ? t('billing.confirmFreeLive') : t('billing.confirmFree')}</p>
      ) : (
        <>
          {monthly != null && <p>{t('billing.confirmMonthly', { amount: money(monthly) })}</p>}
          {live && <p>{t('billing.confirmProrate')}</p>}
        </>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={toFree ? 'btn-danger' : 'btn-primary'} disabled={busy} onClick={onConfirm} data-testid="confirm-plan-yes">
          {toFree ? t('billing.confirmFreeYes') : t('billing.confirmChangeYes', { plan: t(`plans.${plan}`) })}
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

/** Card subscription state under the plan: waiting for the card, charged monthly, or a failed charge. */
function BillingStatus({ info, canChange, busy, pay, returning }: { info: PlanInfoDto; canChange: boolean; busy: boolean; pay: (p: PlanId) => void; returning: boolean }) {
  const { t, i18n } = useTranslation();
  const b = info.billing;
  // Stripe's own page: change the card, see invoices, cancel.
  const portal = useMutation({
    mutationFn: () => api<{ url: string }>('/tenant/billing/portal', { method: 'POST' }),
    onSuccess: (r) => window.location.assign(r.url),
  });
  const date = (iso: string, plusDays = 0) =>
    new Date(new Date(iso).getTime() + plusDays * 86_400_000).toLocaleDateString(i18n.language.startsWith('en') ? 'en-US' : 'es-MX', { day: 'numeric', month: 'long' });
  if (b.status === 'pending' && b.pendingPlan) {
    return (
      <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900" data-testid="billing-pending">
        {returning ? t('billing.confirming') : t('billing.pending', { plan: t(`plans.${b.pendingPlan}`) })}
        {canChange && !returning && (
          <button type="button" className="btn-primary mt-2 block" disabled={busy} onClick={() => pay(b.pendingPlan!)}>{t('billing.payNow')}</button>
        )}
      </div>
    );
  }
  if (b.status === 'past_due') {
    return (
      <div className="rounded-lg bg-rose-50 p-3 text-sm text-rose-900" data-testid="billing-past-due">
        {b.readOnly ? t('billing.readOnly') : t('billing.pastDue', { date: b.pastDueSince ? date(b.pastDueSince, BILLING_GRACE_DAYS) : '' })}
        {canChange && (
          <button type="button" className="btn-primary mt-2 block" disabled={busy || portal.isPending} onClick={() => (b.pendingPlan ? pay(b.pendingPlan) : portal.mutate())}>{t('billing.updateCard')}</button>
        )}
        <ErrorText error={portal.error} />
      </div>
    );
  }
  if (b.status === 'active') {
    return (
      <div className="text-sm text-slate-600" data-testid="billing-active">
        {t('billing.active', { amount: b.amountCents != null ? money(b.amountCents) : '' })}{' '}
        {canChange && (
          <button type="button" className="font-medium text-brand-700 hover:underline" disabled={portal.isPending} onClick={() => portal.mutate()} data-testid="billing-portal">{t('billing.manage')}</button>
        )}
        <ErrorText error={portal.error} />
      </div>
    );
  }
  if (b.status === 'cancelled') return <p className="text-sm text-slate-600">{t('billing.cancelled')}</p>;
  return null;
}
