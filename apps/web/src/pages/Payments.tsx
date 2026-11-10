import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { addDays, addMonths, format, startOfDay, startOfMonth, startOfYear } from 'date-fns';
import { PAYMENT_METHODS, PAYMENT_STATUSES, type PaymentDto } from '@agenda/shared';
import { Empty, Loading, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, money, toCents } from '../lib/format';
import { SortTh, sortRows, useSort } from '../components/SortableTable';

type Preset = 'thisMonth' | 'lastMonth' | 'last7' | 'last30' | 'thisYear' | 'custom';

/** [from, to) of a preset, in local time. */
function presetRange(p: Preset, custom: { from: string; to: string }): [Date, Date] {
  const today = startOfDay(new Date());
  switch (p) {
    case 'thisMonth':
      return [startOfMonth(today), addMonths(startOfMonth(today), 1)];
    case 'lastMonth':
      return [addMonths(startOfMonth(today), -1), startOfMonth(today)];
    case 'last7':
      return [addDays(today, -6), addDays(today, 1)];
    case 'last30':
      return [addDays(today, -29), addDays(today, 1)];
    case 'thisYear':
      return [startOfYear(today), addDays(today, 1)];
    case 'custom': {
      const [fy, fm, fd] = custom.from.split('-').map(Number);
      const [ty, tm, td] = custom.to.split('-').map(Number);
      return [new Date(fy!, fm! - 1, fd), addDays(new Date(ty!, tm! - 1, td), 1)];
    }
  }
}

const EMPTY_FILTERS = { business: 'current', location: '', method: '', status: '', min: '', max: '', q: '' };

/**
 * Every payment with filters: dates, business (owners with several), location, method, status,
 * amount and customer. Totals follow the filters.
 */
export function PaymentsPage() {
  const { t } = useTranslation();
  const { tenant, businesses } = useAuth();
  const [preset, setPreset] = useState<Preset>('thisMonth');
  const [custom, setCustom] = useState(() => ({ from: format(startOfMonth(new Date()), 'yyyy-MM-dd'), to: format(new Date(), 'yyyy-MM-dd') }));
  const [f, setF] = useState(EMPTY_FILTERS);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const [from, to] = presetRange(preset, custom);

  // Businesses this login runs whole (owner/admin); with more than one, they can be listed together.
  const ownBusinesses = businesses.filter((b) => b.role === 'owner' || b.role === 'admin');
  const multiBusiness = ownBusinesses.length > 1;
  const allBusinesses = multiBusiness && f.business !== 'current';

  const { data, isLoading } = useQuery({
    queryKey: ['payments', from.toISOString(), to.toISOString(), allBusinesses],
    queryFn: () =>
      api<PaymentDto[]>(
        `/payments?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}${allBusinesses ? '&all=1' : ''}`,
      ),
  });

  const locationOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of data ?? []) if (p.locationId && p.locationName) m.set(p.locationId, allBusinesses ? `${p.businessName} · ${p.locationName}` : p.locationName);
    return [...m].sort((a, b) => a[1].localeCompare(b[1], 'es'));
  }, [data, allBusinesses]);

  const filtered = useMemo(() => {
    const min = f.min === '' ? null : toCents(f.min);
    const max = f.max === '' ? null : toCents(f.max);
    const q = f.q.trim().toLocaleLowerCase('es');
    return (data ?? []).filter(
      (p) =>
        (!allBusinesses || f.business === 'all' || p.tenantId === f.business) &&
        (!f.location || (f.location === 'none' ? !p.locationId : p.locationId === f.location)) &&
        (!f.method || p.method === f.method) &&
        (!f.status || p.status === f.status) &&
        (min == null || p.amountCents >= min) &&
        (max == null || p.amountCents <= max) &&
        (!q || (p.customerName ?? '').toLocaleLowerCase('es').includes(q) || (p.serviceName ?? '').toLocaleLowerCase('es').includes(q)),
    );
  }, [data, f, allBusinesses]);

  type Key = 'date' | 'customer' | 'method' | 'status' | 'amount' | 'location' | 'business';
  const { sort, toggle } = useSort<Key>({ key: 'date', dir: 'desc' }, { date: 'desc', amount: 'desc' });
  const rows = useMemo(() => {
    const get: Record<Key, (p: PaymentDto) => string | number | null | undefined> = {
      date: (p) => new Date(p.paidAt ?? p.createdAt).getTime(),
      customer: (p) => p.customerName ?? '',
      method: (p) => t(`methods.${p.method}`),
      status: (p) => t(`paymentStatus.${p.status}`),
      amount: (p) => p.amountCents,
      location: (p) => p.locationName,
      business: (p) => p.businessName,
    };
    return sortRows(filtered, get[sort.key], sort.dir);
  }, [filtered, sort, t]);

  const totals = useMemo(() => {
    const sum = (st: PaymentDto['status']) => filtered.filter((p) => p.status === st).reduce((s, p) => s + p.amountCents, 0);
    return { paid: sum('paid'), pending: sum('pending'), refunded: sum('refunded') };
  }, [filtered]);

  const showLocation = locationOptions.length > 1;
  const active = Object.entries(f).filter(([k, v]) => v !== EMPTY_FILTERS[k as keyof typeof EMPTY_FILTERS]).length;

  return (
    <>
      <PageHeader title={t('payments.title')} />

      <div className="card mb-4 space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="label" htmlFor="pf-period">{t('payments.period')}</label>
            <select id="pf-period" className="input" value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
              {(['thisMonth', 'lastMonth', 'last7', 'last30', 'thisYear', 'custom'] as const).map((p) => (
                <option key={p} value={p}>{t(`payments.presets.${p}`)}</option>
              ))}
            </select>
          </div>
          {preset === 'custom' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label" htmlFor="pf-from">{t('payments.from')}</label>
                <input id="pf-from" type="date" className="input" value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} />
              </div>
              <div>
                <label className="label" htmlFor="pf-to">{t('payments.to')}</label>
                <input id="pf-to" type="date" className="input" value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} />
              </div>
            </div>
          )}
          {multiBusiness && (
            <div>
              <label className="label" htmlFor="pf-biz">{t('payments.business')}</label>
              <select id="pf-biz" className="input" value={f.business} onChange={(e) => set({ business: e.target.value, location: '' })}>
                <option value="current">{tenant?.name}</option>
                <option value="all">{t('payments.allBusinesses')}</option>
                {ownBusinesses.filter((b) => b.id !== tenant?.id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}
          {showLocation && (
            <div>
              <label className="label" htmlFor="pf-loc">{t('locations.location')}</label>
              <select id="pf-loc" className="input" value={f.location} onChange={(e) => set({ location: e.target.value })}>
                <option value="">{t('locations.all')}</option>
                {locationOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                <option value="none">{t('payments.noLocation')}</option>
              </select>
            </div>
          )}
          <div>
            <label className="label" htmlFor="pf-method">{t('payments.method')}</label>
            <select id="pf-method" className="input" value={f.method} onChange={(e) => set({ method: e.target.value })}>
              <option value="">{t('payments.any')}</option>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(`methods.${m}`)}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="pf-status">{t('payments.status')}</label>
            <select id="pf-status" className="input" value={f.status} onChange={(e) => set({ status: e.target.value })}>
              <option value="">{t('payments.any')}</option>
              {PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{t(`paymentStatus.${s}`)}</option>)}
            </select>
          </div>
          <div>
            <div className="label">{t('payments.amountRange')}</div>
            <div className="flex items-center gap-2">
              <input type="number" min={0} step="0.01" inputMode="decimal" className="input" aria-label={t('payments.min')} placeholder={t('payments.min')} value={f.min} onChange={(e) => set({ min: e.target.value })} />
              <span className="text-slate-400">–</span>
              <input type="number" min={0} step="0.01" inputMode="decimal" className="input" aria-label={t('payments.max')} placeholder={t('payments.max')} value={f.max} onChange={(e) => set({ max: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="label" htmlFor="pf-q">{t('payments.search')}</label>
            <input id="pf-q" className="input" placeholder={t('payments.searchPlaceholder')} value={f.q} onChange={(e) => set({ q: e.target.value })} />
          </div>
        </div>
        {active > 0 && (
          <button type="button" className="text-sm font-medium text-brand-700 hover:underline" onClick={() => setF({ ...EMPTY_FILTERS, business: f.business })}>
            {t('payments.clearFilters')}
          </button>
        )}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="card"><div className="text-sm text-slate-500">{t('payments.paidTotal')}</div><div className="text-xl font-semibold text-emerald-700">{money(totals.paid)}</div></div>
        <div className="card"><div className="text-sm text-slate-500">{t('payments.pendingTotal')}</div><div className="text-xl font-semibold text-amber-700">{money(totals.pending)}</div></div>
        <div className="card"><div className="text-sm text-slate-500">{t('payments.refundedTotal')}</div><div className="text-xl font-semibold text-slate-600">{money(totals.refunded)}</div></div>
        <div className="card"><div className="text-sm text-slate-500">{t('payments.count')}</div><div className="text-xl font-semibold">{filtered.length}</div></div>
      </div>

      {isLoading ? (
        <Loading />
      ) : !rows.length ? (
        <Empty>{data?.length ? t('payments.noMatch') : t('payments.empty')}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <SortTh label={t('payments.date')} k="date" sort={sort} onSort={toggle} />
                <SortTh label={t('payments.customer')} k="customer" sort={sort} onSort={toggle} />
                {allBusinesses && <SortTh label={t('payments.business')} k="business" sort={sort} onSort={toggle} className="hidden md:table-cell" />}
                {showLocation && <SortTh label={t('locations.location')} k="location" sort={sort} onSort={toggle} className="hidden md:table-cell" />}
                <SortTh label={t('payments.method')} k="method" sort={sort} onSort={toggle} />
                <SortTh label={t('payments.status')} k="status" sort={sort} onSort={toggle} />
                <SortTh label={t('payments.amount')} k="amount" sort={sort} onSort={toggle} align="right" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((p) => (
                <tr key={p.id}>
                  <td className="whitespace-nowrap px-4 py-3">{dateTime(p.paidAt ?? p.createdAt)}</td>
                  <td className="px-4 py-3">
                    {p.tenantId && p.tenantId !== tenant?.id ? (
                      <span>{p.customerName}</span>
                    ) : (
                      <Link className="hover:text-brand-700" to={`/customers/${p.customerId}`}>{p.customerName}</Link>
                    )}
                    {p.serviceName && <div className="text-xs text-slate-500">{p.serviceName}</div>}
                  </td>
                  {allBusinesses && <td className="hidden px-4 py-3 md:table-cell">{p.businessName}</td>}
                  {showLocation && <td className="hidden px-4 py-3 md:table-cell">{p.locationName ?? '—'}</td>}
                  <td className="px-4 py-3">{t(`methods.${p.method}`)}</td>
                  <td className="px-4 py-3">
                    {t(`paymentStatus.${p.status}`)}
                    {p.status === 'pending' && p.checkoutUrl && (
                      <a className="ml-2 text-brand-700 hover:underline" href={p.checkoutUrl} target="_blank" rel="noreferrer">link</a>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-medium">{money(p.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
