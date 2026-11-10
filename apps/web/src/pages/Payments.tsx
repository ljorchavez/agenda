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
import { FILTER_CTRL, FilterBar } from '../components/FilterBar';

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

/** Same cap as the API: getting exactly this many means the period has more. */
const MAX_ROWS = 5000;

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

  return (
    <>
      <PageHeader title={t('payments.title')} />

      <FilterBar
        active={[f.location, f.method, f.status, f.min, f.max, multiBusiness && f.business !== 'current' ? 'b' : ''].filter(Boolean).length}
        onClear={() => setF({ ...EMPTY_FILTERS, q: f.q })}
        primary={
          <>
            <select className={FILTER_CTRL} aria-label={t('payments.period')} value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
              {(['thisMonth', 'lastMonth', 'last7', 'last30', 'thisYear', 'custom'] as const).map((p) => (
                <option key={p} value={p}>{t(`payments.presets.${p}`)}</option>
              ))}
            </select>
            {preset === 'custom' && (
              <span className="flex items-center gap-1">
                <input type="date" className={FILTER_CTRL} aria-label={t('payments.from')} value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} />
                <span className="text-slate-400">–</span>
                <input type="date" className={FILTER_CTRL} aria-label={t('payments.to')} value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} />
              </span>
            )}
            <input
              type="search"
              className={`${FILTER_CTRL} min-w-0 flex-1 sm:!w-56 sm:flex-none`}
              aria-label={t('payments.search')}
              placeholder={t('payments.searchPlaceholder')}
              value={f.q}
              onChange={(e) => set({ q: e.target.value })}
            />
          </>
        }
      >
        {multiBusiness && (
          <select id="pf-biz" className={FILTER_CTRL} aria-label={t('payments.business')} value={f.business} onChange={(e) => set({ business: e.target.value, location: '' })}>
            <option value="current">{t('payments.business')}: {tenant?.name}</option>
            <option value="all">{t('payments.allBusinesses')}</option>
            {ownBusinesses.filter((b) => b.id !== tenant?.id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        {showLocation && (
          <select id="pf-loc" className={FILTER_CTRL} aria-label={t('locations.location')} value={f.location} onChange={(e) => set({ location: e.target.value })}>
            <option value="">{t('locations.location')}: {t('payments.any')}</option>
            {locationOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            <option value="none">{t('payments.noLocation')}</option>
          </select>
        )}
        <select id="pf-method" className={FILTER_CTRL} aria-label={t('payments.method')} value={f.method} onChange={(e) => set({ method: e.target.value })}>
          <option value="">{t('payments.method')}: {t('payments.any')}</option>
          {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{t(`methods.${m}`)}</option>)}
        </select>
        <select id="pf-status" className={FILTER_CTRL} aria-label={t('payments.status')} value={f.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">{t('payments.status')}: {t('payments.any')}</option>
          {PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{t(`paymentStatus.${s}`)}</option>)}
        </select>
        <span className="flex items-center gap-1 text-sm text-slate-600">
          $
          <input type="number" min={0} step="0.01" inputMode="decimal" className={`${FILTER_CTRL} !w-24`} aria-label={t('payments.min')} placeholder={t('payments.min')} value={f.min} onChange={(e) => set({ min: e.target.value })} />
          –
          <input type="number" min={0} step="0.01" inputMode="decimal" className={`${FILTER_CTRL} !w-24`} aria-label={t('payments.max')} placeholder={t('payments.max')} value={f.max} onChange={(e) => set({ max: e.target.value })} />
        </span>
      </FilterBar>

      {data?.length === MAX_ROWS && (
        <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{t('payments.tooMany', { count: MAX_ROWS })}</p>
      )}
      <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm">
        <span>{t('payments.paidTotal')}: <b className="text-emerald-700">{money(totals.paid)}</b></span>
        <span>{t('payments.pendingTotal')}: <b className="text-amber-700">{money(totals.pending)}</b></span>
        {totals.refunded > 0 && <span>{t('payments.refundedTotal')}: <b className="text-slate-600">{money(totals.refunded)}</b></span>}
        <span className="text-slate-500">{t('payments.count')}: {filtered.length}</span>
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
