import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { addDays, format, startOfDay, startOfMonth, subDays } from 'date-fns';
import { IN_PERSON_ACCEPTED, type SaleDto } from '@agenda/shared';
import { api } from '../lib/api';
import { useAccess } from '../lib/auth';
import { dateTime, money } from '../lib/format';
import { openTicket } from '../pages/Ticket';
import { CashTab } from './Cash';
import { FILTER_CTRL, FilterBar, MultiPick } from './FilterBar';
import { DataTable, useColumns } from './Columns';
import { ReportsView } from '../pages/Reports';
import { useMyLocations } from '../lib/queries';
import { PosLocation, PosTab, ProductsTab, SaleActions } from './Pos';
import { UpgradeNote, useFeature } from './Sales';
import { Empty, Loading, PageHeader, PageTabs } from './ui';

type Tab = 'sell' | 'sales' | 'products' | 'cash' | 'reports';

/** Punto de venta: sell, the sales made (with filters), the catalog and the cash closing. */
export function PosPage() {
  const { t } = useTranslation();
  const { manager } = useAccess();
  const [params, setParams] = useSearchParams();
  const tabs: Tab[] = ['sell', 'sales', ...(manager ? (['products', 'cash', 'reports'] as Tab[]) : [])];
  const asked = params.get('tab') as Tab | null;
  const tab: Tab = asked && tabs.includes(asked) ? asked : 'sell';
  return (
    <>
      <PageHeader title={t('nav.pos')} tight extra={(tab === 'sell' || tab === 'products') && <PosLocation />} />
      <PageTabs tabs={tabs.map((k) => ({ id: k, label: t(`pos.tabs.${k}`) }))} value={tab} onChange={(k) => setParams(k === 'sell' ? {} : { tab: k })} label={t('nav.pos')} testIdPrefix="pos-tab-" />
      {tab === 'sales' ? <SalesTab /> : tab === 'products' ? <ProductsTab /> : tab === 'cash' ? <CashTab /> : tab === 'reports' ? <ReportsView scope="pos" /> : <PosTab />}
    </>
  );
}

type Preset = 'today' | 'yesterday' | 'last7' | 'thisMonth' | 'custom';
const PRESETS: Preset[] = ['today', 'yesterday', 'last7', 'thisMonth', 'custom'];
const ymd = (d: Date) => format(d, 'yyyy-MM-dd');

function range(p: Preset, custom: { from: string; to: string }): [Date, Date] {
  const today = startOfDay(new Date());
  if (p === 'yesterday') return [subDays(today, 1), today];
  if (p === 'last7') return [subDays(today, 6), addDays(today, 1)];
  if (p === 'thisMonth') return [startOfMonth(today), addDays(today, 1)];
  if (p === 'custom') return [new Date(`${custom.from}T00:00:00`), addDays(new Date(`${custom.to}T00:00:00`), 1)];
  return [today, addDays(today, 1)];
}

const EMPTY = { q: '', invoiced: '', method: '', status: '', locations: [] as string[] };

/** Every counter sale of a period (today by default), of every location: find by ticket, customer or product. */
function SalesTab() {
  const { t } = useTranslation();
  const enabled = useFeature('cash');
  const { locationId: own } = useAccess();
  const locs = useMyLocations(own);
  const [preset, setPreset] = useState<Preset>('today');
  const [custom, setCustom] = useState(() => ({ from: ymd(new Date()), to: ymd(new Date()) }));
  const [f, setF] = useState(EMPTY);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const [from, to] = range(preset, custom);
  const sales = useQuery({
    queryKey: ['sales', 'list', from.toISOString(), to.toISOString()],
    queryFn: () => api<SaleDto[]>(`/sales?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`),
    enabled,
  });

  const list = useMemo(() => {
    const q = f.q.trim().toLocaleLowerCase('es').replace(/^#/, '');
    return (sales.data ?? []).filter(
      (s) =>
        (!q ||
          String(s.number) === q ||
          (s.customerName ?? '').toLocaleLowerCase('es').includes(q) ||
          s.items.some((i) => i.name.toLocaleLowerCase('es').includes(q))) &&
        (!f.locations.length || f.locations.includes(s.locationId)) &&
        (!f.invoiced || (f.invoiced === 'yes' ? Boolean(s.invoice) : !s.invoice)) &&
        (!f.method || s.payments.some((p) => p.method === f.method)) &&
        (!f.status || s.status === f.status),
    );
  }, [sales.data, f]);
  const paid = list.filter((s) => s.status === 'paid');
  const totalCents = paid.reduce((a, s) => a + s.totalCents, 0);
  const units = paid.reduce((a, s) => a + s.items.reduce((b, i) => b + i.qty, 0), 0);

  const { cols, menu } = useColumns<SaleDto>('pos-sales', [
    {
      key: 'ticket', label: t('pos.salesTab.ticket'), required: true, className: 'whitespace-nowrap font-medium',
      td: (s) => (
        <>
          <button type="button" className="hover:text-brand-700 hover:underline" onClick={() => openTicket(s.id)}>#{s.number}</button>
          {s.status === 'canceled' && <div className="text-xs text-rose-700">{t('pos.canceled')}</div>}
        </>
      ),
    },
    { key: 'date', label: t('payments.date'), className: 'whitespace-nowrap', td: (s) => dateTime(s.createdAt) },
    { key: 'customer', label: t('payments.customer'), td: (s) => s.customerName ?? <span className="text-slate-400">—</span> },
    ...(locs.multi ? [{ key: 'location', label: t('locations.location'), td: (s: SaleDto) => s.locationName ?? '—' }] : []),
    { key: 'products', label: t('pos.products'), className: 'max-w-xs text-slate-600', td: (s) => <span className="line-clamp-2">{s.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</span> },
    { key: 'method', label: t('payments.method'), className: 'whitespace-nowrap', td: (s) => s.payments.map((p) => t(`methods.${p.method}`)).join(' + ') },
    { key: 'seller', label: t('pos.salesTab.seller'), hidden: true, td: (s) => s.createdByName ?? '—' },
    { key: 'total', label: t('pos.total'), className: 'whitespace-nowrap text-right font-semibold', td: (s) => money(s.totalCents) },
    { key: 'actions', label: t('columns.actions'), required: true, className: 'text-right text-xs', td: (s) => <SaleActions sale={s} /> },
  ]);

  if (!enabled) return <UpgradeNote feature="cash" />;
  return (
    <section className="space-y-3" data-testid="sales-tab">
      <FilterBar
        active={[f.invoiced, f.method, f.status].filter(Boolean).length}
        onClear={() => setF({ ...EMPTY, q: f.q, locations: f.locations })}
        primary={
          <>
            <select className={FILTER_CTRL} aria-label={t('payments.period')} value={preset} onChange={(e) => setPreset(e.target.value as Preset)} data-testid="sales-preset">
              {PRESETS.map((p) => <option key={p} value={p}>{t(`pos.salesTab.presets.${p}`)}</option>)}
            </select>
            {preset === 'custom' && (
              <span className="flex items-center gap-1">
                <input type="date" className={FILTER_CTRL} aria-label={t('payments.from')} value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom({ ...custom, from: e.target.value })} data-testid="sales-from" />
                <span className="text-slate-400">–</span>
                <input type="date" className={FILTER_CTRL} aria-label={t('payments.to')} value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom({ ...custom, to: e.target.value })} data-testid="sales-to" />
              </span>
            )}
            {locs.multi && (
              <MultiPick
                label={t('locations.location')}
                allLabel={t('pos.salesTab.allLocations')}
                options={locs.list.map((l) => ({ id: l.id, name: l.name }))}
                value={f.locations}
                onChange={(locations) => set({ locations })}
                testId="sales-locations"
              />
            )}
            <input
              type="search"
              className={`${FILTER_CTRL} min-w-0 flex-1 sm:!w-64 sm:flex-none`}
              placeholder={t('pos.salesTab.search')}
              aria-label={t('pos.salesTab.search')}
              value={f.q}
              onChange={(e) => set({ q: e.target.value })}
              data-testid="sales-search"
            />
          </>
        }
      >
        <select className={FILTER_CTRL} aria-label={t('pos.salesTab.invoiced')} value={f.invoiced} onChange={(e) => set({ invoiced: e.target.value })} data-testid="sales-invoiced">
          <option value="">{t('pos.salesTab.invoiced')}: {t('payments.any')}</option>
          <option value="yes">{t('pos.salesTab.withInvoice')}</option>
          <option value="no">{t('pos.salesTab.withoutInvoice')}</option>
        </select>
        <select className={FILTER_CTRL} aria-label={t('payments.method')} value={f.method} onChange={(e) => set({ method: e.target.value })}>
          <option value="">{t('payments.method')}: {t('payments.any')}</option>
          {IN_PERSON_ACCEPTED.map((m) => <option key={m} value={m}>{t(`methods.${m}`)}</option>)}
        </select>
        <select className={FILTER_CTRL} aria-label={t('payments.status')} value={f.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">{t('payments.status')}: {t('payments.any')}</option>
          <option value="paid">{t('pos.salesTab.paid')}</option>
          <option value="canceled">{t('pos.canceled')}</option>
        </select>
      </FilterBar>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm" data-testid="sales-totals">
        <span>{t('pos.salesTab.total')}: <b className="text-emerald-700">{money(totalCents)}</b></span>
        <span className="text-slate-600">{t('pos.salesTab.count', { count: paid.length })}</span>
        <span className="text-slate-600">{t('pos.salesTab.units', { count: units })}</span>
        {paid.length > 0 && <span className="text-slate-600">{t('pos.salesTab.avg')}: {money(Math.round(totalCents / paid.length))}</span>}
        <span className="ml-auto">{menu}</span>
      </div>

      {sales.isLoading ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty>{sales.data?.length ? t('payments.noMatch') : t('pos.noSales')}</Empty>
      ) : (
        <DataTable cols={cols} rows={list} rowKey={(s) => s.id} rowClassName={(s) => (s.status === 'canceled' ? 'opacity-50' : '')} rowTestId="sales-row" />
      )}
    </section>
  );
}
