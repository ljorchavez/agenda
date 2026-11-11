import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ADDON_PRICES, PLAN_LIMITS, PLANS, SELECTABLE_PLANS, type PlanId, type PlanInfoDto } from '@agenda/shared';
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
  const info = useQuery({ queryKey: ['plan'], queryFn: () => api<PlanInfoDto>('/tenant/plan') });
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
          {changing && (
            <div className="pt-2">
              <PlanCards current={p.plan} busy={change.isPending} onPick={(x) => change.mutate(x)} />
              <PlanExtras />
            </div>
          )}
          <ErrorText error={change.error} />
        </>
      )}
    </section>
  );
}
