import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { InvoiceCell, useInvoicing } from '../components/Invoicing';
import { addDays, addMonths, format, startOfDay, startOfMonth, startOfYear } from 'date-fns';
import {
  MANUAL_METHODS,
  OWED_STATES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  paymentSettingsOf,
  type CollectionDto,
  type CollectionState,
  type PaymentDto,
} from '@agenda/shared';
import { Empty, ErrorText, Loading, Modal, PageHeader, usePaged } from '../components/ui';
import { CashTab, CommissionsTab } from '../components/Cash';
import { PosTab, ProductsTab } from '../components/Pos';
import { useAccess } from '../lib/auth';
import { COLLECTION_PILL, PAYMENT_PILL, PAYMENT_PILL_TEXT } from '../lib/status';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, money, toCents } from '../lib/format';
import { SortTh, sortRows, useSort } from '../components/SortableTable';
import { FILTER_CTRL, FilterBar } from '../components/FilterBar';

type Preset = 'thisMonth' | 'lastMonth' | 'next7' | 'next30' | 'last7' | 'last30' | 'thisYear' | 'custom';

/** [from, to) of a preset, in local time. */
function presetRange(p: Preset, custom: { from: string; to: string }): [Date, Date] {
  const today = startOfDay(new Date());
  switch (p) {
    case 'thisMonth':
      return [startOfMonth(today), addMonths(startOfMonth(today), 1)];
    case 'lastMonth':
      return [addMonths(startOfMonth(today), -1), startOfMonth(today)];
    case 'next7':
      return [today, addDays(today, 7)];
    case 'next30':
      return [today, addDays(today, 30)];
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

const MOVEMENT_PRESETS: Preset[] = ['thisMonth', 'lastMonth', 'last7', 'last30', 'thisYear', 'custom'];
const COLLECTION_PRESETS: Preset[] = ['thisMonth', 'next7', 'next30', 'last7', 'last30', 'lastMonth', 'thisYear', 'custom'];

const EMPTY_FILTERS = { business: 'current', location: '', method: '', status: '', min: '', max: '', q: '' };

/**
 * Money movements (payments actually recorded): dates, business, location, method, status, amount
 * and customer. Totals follow the filters.
 */
function MovementsTab() {
  const { manager } = useAccess();
  const inv = useInvoicing(manager);
  const invoicing = Boolean(inv.data?.available && inv.data.connected);
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
  const { pageRows, pager } = usePaged(rows);

  const totals = useMemo(() => {
    const sum = (st: PaymentDto['status']) => filtered.filter((p) => p.status === st).reduce((s, p) => s + p.amountCents, 0);
    return { paid: sum('paid'), pending: sum('pending'), refunded: sum('refunded') };
  }, [filtered]);

  const showLocation = locationOptions.length > 1;

  return (
    <>
      <FilterBar
        active={[f.location, f.method, f.status, f.min, f.max, multiBusiness && f.business !== 'current' ? 'b' : ''].filter(Boolean).length}
        onClear={() => setF({ ...EMPTY_FILTERS, q: f.q })}
        primary={
          <>
            <select className={FILTER_CTRL} aria-label={t('payments.period')} value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
              {MOVEMENT_PRESETS.map((p) => (
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
                {invoicing && <th className="px-4 py-3 text-right font-medium">{t('invoicing.column')}</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageRows.map((p) => (
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
                  {invoicing && <td className="whitespace-nowrap px-4 py-3 text-right">{(!p.tenantId || p.tenantId === tenant?.id) && <InvoiceCell payment={p} />}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pager}
    </>
  );
}

/** Cobros: bookings with their money state (default tab) and money movements. */
export function PaymentsPage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const { manager, scoped } = useAccess();
  type Tab = 'bookings' | 'pos' | 'movements' | 'products' | 'commissions' | 'cash';
  const tabs: Tab[] = [
    'bookings',
    'pos',
    'movements',
    ...(manager ? (['products'] as Tab[]) : []),
    ...(manager || scoped ? (['commissions'] as Tab[]) : []),
    ...(manager ? (['cash'] as Tab[]) : []),
  ];
  const asked = params.get('tab') as Tab | null;
  const tab: Tab = asked && tabs.includes(asked) ? asked : 'bookings';
  const tabBtn = (k: Tab) =>
    `rounded-md px-3 py-1 text-sm font-medium ${tab === k ? 'bg-brand-700 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`;
  return (
    <>
      <PageHeader
        title={t('payments.title')}
        actions={
          <div className="inline-flex flex-wrap rounded-lg border border-slate-300 bg-white p-0.5" role="tablist">
            {tabs.map((k) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tabBtn(k)} onClick={() => setParams(k === 'bookings' ? {} : { tab: k })}>
                {t(`payments.tabs.${k}`)}
              </button>
            ))}
          </div>
        }
      />
      {tab === 'bookings' ? (
        <CollectionsTab />
      ) : tab === 'pos' ? (
        <PosTab />
      ) : tab === 'movements' ? (
        <MovementsTab />
      ) : tab === 'products' ? (
        <ProductsTab />
      ) : tab === 'commissions' ? (
        <CommissionsTab />
      ) : (
        <CashTab />
      )}
    </>
  );
}

const UPCOMING: CollectionState[] = ['upcoming_unpaid', 'upcoming_deposit', 'upcoming_paid'];
const PAST: CollectionState[] = ['past_unpaid', 'past_partial', 'past_paid'];

function StateBadge({ state }: { state: CollectionState }) {
  const { t } = useTranslation();
  const pill = COLLECTION_PILL[state].pill;
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${PAYMENT_PILL[pill]}`}>
      <span aria-hidden>{PAYMENT_PILL_TEXT[pill]}</span>
      {t(`collections.states.${state}`)}
    </span>
  );
}

/** Every booking of the period: price, paid, balance and one of six states; record payments in place. */
function CollectionsTab() {
  const { t } = useTranslation();
  const { tenant, businesses } = useAuth();
  const [preset, setPreset] = useState<Preset>('thisMonth');
  const [custom, setCustom] = useState(() => ({ from: format(startOfMonth(new Date()), 'yyyy-MM-dd'), to: format(new Date(), 'yyyy-MM-dd') }));
  const [f, setF] = useState({ business: 'current', location: '', state: '' as CollectionState | '', q: '' });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const [from, to] = presetRange(preset, custom);
  const [paying, setPaying] = useState<CollectionDto | null>(null);

  const ownBusinesses = businesses.filter((b) => b.role === 'owner' || b.role === 'admin');
  const multiBusiness = ownBusinesses.length > 1;
  const allBusinesses = multiBusiness && f.business !== 'current';

  const { data, isLoading } = useQuery({
    queryKey: ['collections', from.toISOString(), to.toISOString(), allBusinesses],
    queryFn: () =>
      api<CollectionDto[]>(
        `/collections?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}${allBusinesses ? '&all=1' : ''}`,
      ),
  });

  const locationOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of data ?? []) if (r.locationName) m.set(r.locationId, allBusinesses ? `${r.businessName} · ${r.locationName}` : r.locationName);
    return [...m].sort((a, b) => a[1].localeCompare(b[1], 'es'));
  }, [data, allBusinesses]);

  // Everything but the state filter, so the state tiles always show their full counts.
  const base = useMemo(() => {
    const q = f.q.trim().toLocaleLowerCase('es');
    return (data ?? []).filter(
      (r) =>
        (!allBusinesses || f.business === 'all' || r.tenantId === f.business) &&
        (!f.location || r.locationId === f.location) &&
        (!q || r.customerName.toLocaleLowerCase('es').includes(q) || (r.serviceName ?? '').toLocaleLowerCase('es').includes(q)),
    );
  }, [data, f.business, f.location, f.q, allBusinesses]);
  const filtered = useMemo(() => (f.state ? base.filter((r) => r.state === f.state) : base), [base, f.state]);

  const tiles = useMemo(() => {
    const by = new Map<CollectionState, { count: number; amount: number }>();
    for (const s of [...UPCOMING, ...PAST]) by.set(s, { count: 0, amount: 0 });
    for (const r of base) {
      const x = by.get(r.state)!;
      x.count++;
      // Paid states show money in; the rest show what's still to collect.
      x.amount += r.state.endsWith('_paid') ? r.paidCents : r.balanceCents;
    }
    return by;
  }, [base]);
  const totals = useMemo(() => {
    let collected = 0, upcoming = 0, owed = 0;
    for (const r of base) {
      collected += r.paidCents;
      if (OWED_STATES.includes(r.state)) owed += r.balanceCents;
      else upcoming += r.balanceCents;
    }
    return { collected, upcoming, owed };
  }, [base]);

  type Key = 'date' | 'customer' | 'state' | 'price' | 'paid' | 'balance' | 'location' | 'business';
  const { sort, toggle } = useSort<Key>({ key: 'date', dir: 'desc' }, { date: 'desc', price: 'desc', paid: 'desc', balance: 'desc' });
  const rows = useMemo(() => {
    const order = [...PAST, ...UPCOMING];
    const get: Record<Key, (r: CollectionDto) => string | number | null> = {
      date: (r) => new Date(r.startsAt).getTime(),
      customer: (r) => r.customerName,
      state: (r) => order.indexOf(r.state),
      price: (r) => r.priceCents,
      paid: (r) => r.paidCents,
      balance: (r) => r.balanceCents,
      location: (r) => r.locationName,
      business: (r) => r.businessName,
    };
    return sortRows(filtered, get[sort.key], sort.dir);
  }, [filtered, sort]);
  const { pageRows, pager } = usePaged(rows);
  const showLocation = locationOptions.length > 1;

  const tile = (s: CollectionState) => {
    const x = tiles.get(s)!;
    const on = f.state === s;
    return (
      <button
        key={s}
        type="button"
        aria-pressed={on}
        onClick={() => set({ state: on ? '' : s })}
        className={`flex min-w-0 flex-1 flex-col items-start rounded-lg border px-3 py-2 text-left ${on ? 'border-brand-600 bg-brand-50 ring-1 ring-brand-600' : 'border-slate-200 bg-white hover:border-slate-400'}`}
      >
        <StateBadge state={s} />
        <span className="mt-1 text-lg font-semibold">{money(x.amount)}</span>
        <span className="text-xs text-slate-500">{t('collections.bookingsN', { count: x.count })}</span>
      </button>
    );
  };

  return (
    <>
      <FilterBar
        active={[f.location, multiBusiness && f.business !== 'current' ? 'b' : ''].filter(Boolean).length}
        onClear={() => set({ business: 'current', location: '' })}
        primary={
          <>
            <select className={FILTER_CTRL} aria-label={t('payments.period')} value={preset} onChange={(e) => setPreset(e.target.value as Preset)}>
              {COLLECTION_PRESETS.map((p) => (
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
            <input type="search" className={`${FILTER_CTRL} min-w-0 flex-1 sm:!w-56 sm:flex-none`} aria-label={t('payments.search')} placeholder={t('payments.searchPlaceholder')} value={f.q} onChange={(e) => set({ q: e.target.value })} />
          </>
        }
      >
        {multiBusiness && (
          <select className={FILTER_CTRL} aria-label={t('payments.business')} value={f.business} onChange={(e) => set({ business: e.target.value, location: '' })}>
            <option value="current">{t('payments.business')}: {tenant?.name}</option>
            <option value="all">{t('payments.allBusinesses')}</option>
            {ownBusinesses.filter((b) => b.id !== tenant?.id).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        )}
        {showLocation && (
          <select className={FILTER_CTRL} aria-label={t('locations.location')} value={f.location} onChange={(e) => set({ location: e.target.value })}>
            <option value="">{t('locations.location')}: {t('payments.any')}</option>
            {locationOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        )}
      </FilterBar>

      <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm">
        <span>{t('collections.collected')}: <b className="text-emerald-700">{money(totals.collected)}</b></span>
        <span>{t('collections.toCollect')}: <b className="text-slate-700">{money(totals.upcoming)}</b></span>
        <span>{t('collections.owed')}: <b className="text-rose-700">{money(totals.owed)}</b></span>
      </div>

      <div className="mb-4 space-y-2">
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('collections.upcoming')}</div>
          <div className="flex flex-wrap gap-2">{UPCOMING.map(tile)}</div>
        </div>
        <div>
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{t('collections.past')}</div>
          <div className="flex flex-wrap gap-2">{PAST.map(tile)}</div>
        </div>
      </div>

      {data?.length === MAX_ROWS && <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{t('payments.tooMany', { count: MAX_ROWS })}</p>}

      {isLoading ? (
        <Loading />
      ) : !rows.length ? (
        <Empty>{data?.length ? t('payments.noMatch') : t('collections.empty')}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <SortTh label={t('collections.booking')} k="date" sort={sort} onSort={toggle} />
                <SortTh label={t('payments.customer')} k="customer" sort={sort} onSort={toggle} />
                {allBusinesses && <SortTh label={t('payments.business')} k="business" sort={sort} onSort={toggle} className="hidden md:table-cell" />}
                {showLocation && <SortTh label={t('locations.location')} k="location" sort={sort} onSort={toggle} className="hidden md:table-cell" />}
                <SortTh label={t('collections.state')} k="state" sort={sort} onSort={toggle} />
                <SortTh label={t('collections.price')} k="price" sort={sort} onSort={toggle} align="right" className="hidden sm:table-cell" />
                <SortTh label={t('collections.paid')} k="paid" sort={sort} onSort={toggle} align="right" className="hidden sm:table-cell" />
                <SortTh label={t('collections.balance')} k="balance" sort={sort} onSort={toggle} align="right" />
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {pageRows.map((r) => (
                <tr key={r.appointmentId}>
                  <td className="whitespace-nowrap px-4 py-3">
                    {dateTime(r.startsAt)}
                    <div className="text-xs text-slate-500">{t(`status.${r.status}`)}</div>
                  </td>
                  <td className="px-4 py-3">
                    {r.tenantId === tenant?.id ? (
                      <Link className="hover:text-brand-700" to={`/customers/${r.customerId}`}>{r.customerName}</Link>
                    ) : (
                      r.customerName
                    )}
                    <div className="text-xs text-slate-500">{[r.serviceName, r.resourceName].filter(Boolean).join(' · ')}</div>
                  </td>
                  {allBusinesses && <td className="hidden px-4 py-3 md:table-cell">{r.businessName}</td>}
                  {showLocation && <td className="hidden px-4 py-3 md:table-cell">{r.locationName ?? '—'}</td>}
                  <td className="px-4 py-3">
                    <StateBadge state={r.state} />
                    {r.methods.length > 0 && <div className="mt-0.5 text-xs text-slate-500">{r.methods.map((m) => t(`methods.${m}`)).join(', ')}</div>}
                  </td>
                  <td className="hidden px-4 py-3 text-right sm:table-cell">{money(r.priceCents)}</td>
                  <td className="hidden px-4 py-3 text-right text-emerald-700 sm:table-cell">{money(r.paidCents)}</td>
                  <td className={`px-4 py-3 text-right font-semibold ${r.balanceCents ? (OWED_STATES.includes(r.state) ? 'text-rose-700' : 'text-slate-800') : 'text-slate-400'}`}>
                    {money(r.balanceCents)}
                  </td>
                  <td className="px-2 py-3 text-right">
                    {r.balanceCents > 0 && r.tenantId === tenant?.id && (
                      <button type="button" className="btn-secondary !px-2.5 !py-1 text-xs" onClick={() => setPaying(r)}>
                        {t('collections.record')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pager}
      {paying && <RecordPaymentModal row={paying} onClose={() => setPaying(null)} />}
    </>
  );
}

/** Money received in person (cash, card terminal, transfer). Mercado Pago is recorded by itself. */
function RecordPaymentModal({ row, onClose }: { row: CollectionDto; onClose: () => void }) {
  const { t } = useTranslation();
  const { tenant } = useAuth();
  const qc = useQueryClient();
  const accepted = MANUAL_METHODS.filter((m) => paymentSettingsOf(tenant!.settings).methods[m]);
  const options = accepted.length ? accepted : [...MANUAL_METHODS];
  const [amount, setAmount] = useState(String(row.balanceCents / 100));
  const [method, setMethod] = useState<(typeof MANUAL_METHODS)[number]>(options[0]!);
  const save = useMutation({
    mutationFn: () =>
      api('/payments', { method: 'POST', body: { customerId: row.customerId, appointmentId: row.appointmentId, amountCents: toCents(amount), method } }),
    onSuccess: () => {
      for (const k of ['collections', 'payments', 'appointments', 'customers']) void qc.invalidateQueries({ queryKey: [k] });
      onClose();
    },
  });
  return (
    <Modal open title={t('collections.record')} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="text-sm text-slate-600">
          <b>{row.customerName}</b> · {row.serviceName} · {dateTime(row.startsAt)}
          <br />
          {t('collections.balance')}: <b>{money(row.balanceCents)}</b>
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="rp-amount">{t('payments.amount')}</label>
            <input id="rp-amount" type="number" min={0.01} step="0.01" required className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label className="label" htmlFor="rp-method">{t('payments.method')}</label>
            <select id="rp-method" className="input" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              {options.map((m) => <option key={m} value={m}>{t(`methods.${m}`)}</option>)}
            </select>
          </div>
        </div>
        <p className="text-xs text-slate-500">{t('collections.mpNote')}</p>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={save.isPending}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  );
}
