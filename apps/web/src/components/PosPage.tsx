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
import { FILTER_CTRL, FilterBar } from './FilterBar';
import { PosTab, ProductsTab, SaleActions, useLocationChoice } from './Pos';
import { UpgradeNote, useFeature } from './Sales';
import { Loading } from './ui';

type Tab = 'sell' | 'sales' | 'products' | 'cash';

/** Punto de venta: sell, the sales made (with filters), the catalog and the cash closing. */
export function PosPage() {
  const { t } = useTranslation();
  const { manager } = useAccess();
  const [params, setParams] = useSearchParams();
  const tabs: Tab[] = ['sell', 'sales', ...(manager ? (['products', 'cash'] as Tab[]) : [])];
  const asked = params.get('tab') as Tab | null;
  const tab: Tab = asked && tabs.includes(asked) ? asked : 'sell';
  const btn = (k: Tab) => `rounded-md px-3 py-1 text-sm font-medium ${tab === k ? 'bg-brand-700 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`;
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-slate-900">{t('nav.pos')}</h1>
        <div className="inline-flex flex-wrap rounded-lg border border-slate-300 bg-white p-0.5" role="tablist">
          {tabs.map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={btn(k)} onClick={() => setParams(k === 'sell' ? {} : { tab: k })} data-testid={`pos-tab-${k}`}>
              {t(`pos.tabs.${k}`)}
            </button>
          ))}
        </div>
      </div>
      {tab === 'sales' ? <SalesTab /> : tab === 'products' ? <ProductsTab /> : tab === 'cash' ? <CashTab /> : <PosTab />}
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

const EMPTY = { q: '', invoiced: '', method: '', status: '' };

/** Every counter sale of a period (today by default): find by ticket, customer or product. */
function SalesTab() {
  const { t } = useTranslation();
  const enabled = useFeature('cash');
  const { locationId, picker } = useLocationChoice();
  const [preset, setPreset] = useState<Preset>('today');
  const [custom, setCustom] = useState(() => ({ from: ymd(new Date()), to: ymd(new Date()) }));
  const [f, setF] = useState(EMPTY);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const [from, to] = range(preset, custom);
  const sales = useQuery({
    queryKey: ['sales', 'list', locationId, from.toISOString(), to.toISOString()],
    queryFn: () => api<SaleDto[]>(`/sales?locationId=${locationId}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`),
    enabled: enabled && Boolean(locationId),
  });

  const list = useMemo(() => {
    const q = f.q.trim().toLocaleLowerCase('es').replace(/^#/, '');
    return (sales.data ?? []).filter(
      (s) =>
        (!q ||
          String(s.number) === q ||
          (s.customerName ?? '').toLocaleLowerCase('es').includes(q) ||
          s.items.some((i) => i.name.toLocaleLowerCase('es').includes(q))) &&
        (!f.invoiced || (f.invoiced === 'yes' ? Boolean(s.invoice) : !s.invoice)) &&
        (!f.method || s.payments.some((p) => p.method === f.method)) &&
        (!f.status || s.status === f.status),
    );
  }, [sales.data, f]);
  const paid = list.filter((s) => s.status === 'paid');
  const totalCents = paid.reduce((a, s) => a + s.totalCents, 0);
  const units = paid.reduce((a, s) => a + s.items.reduce((b, i) => b + i.qty, 0), 0);

  if (!enabled) return <UpgradeNote feature="cash" />;
  return (
    <section className="space-y-3" data-testid="sales-tab">
      <FilterBar
        active={[f.invoiced, f.method, f.status].filter(Boolean).length}
        onClear={() => setF({ ...EMPTY, q: f.q })}
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
            <input
              type="search"
              className={`${FILTER_CTRL} min-w-0 flex-1 sm:!w-64 sm:flex-none`}
              placeholder={t('pos.salesTab.search')}
              aria-label={t('pos.salesTab.search')}
              value={f.q}
              onChange={(e) => set({ q: e.target.value })}
              data-testid="sales-search"
            />
            {picker}
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

      <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm" data-testid="sales-totals">
        <span>{t('pos.salesTab.total')}: <b className="text-emerald-700">{money(totalCents)}</b></span>
        <span className="text-slate-600">{t('pos.salesTab.count', { count: paid.length })}</span>
        <span className="text-slate-600">{t('pos.salesTab.units', { count: units })}</span>
        {paid.length > 0 && <span className="text-slate-600">{t('pos.salesTab.avg')}: {money(Math.round(totalCents / paid.length))}</span>}
      </div>

      {sales.isLoading ? (
        <Loading />
      ) : list.length === 0 ? (
        <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">{sales.data?.length ? t('payments.noMatch') : t('pos.noSales')}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">{t('pos.salesTab.ticket')}</th>
                <th className="px-4 py-3 font-medium">{t('payments.date')}</th>
                <th className="px-4 py-3 font-medium">{t('payments.customer')}</th>
                <th className="hidden px-4 py-3 font-medium md:table-cell">{t('pos.products')}</th>
                <th className="px-4 py-3 font-medium">{t('payments.method')}</th>
                <th className="px-4 py-3 text-right font-medium">{t('pos.total')}</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((s) => (
                <tr key={s.id} className={s.status === 'canceled' ? 'opacity-50' : ''} data-testid="sales-row">
                  <td className="whitespace-nowrap px-4 py-3 font-medium">
                    <button type="button" className="hover:text-brand-700 hover:underline" onClick={() => openTicket(s.id)}>#{s.number}</button>
                    {s.status === 'canceled' && <div className="text-xs text-rose-700">{t('pos.canceled')}</div>}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">{dateTime(s.createdAt)}</td>
                  <td className="px-4 py-3">{s.customerName ?? <span className="text-slate-400">—</span>}</td>
                  <td className="hidden max-w-xs px-4 py-3 text-slate-600 md:table-cell">
                    <span className="line-clamp-2">{s.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3">{s.payments.map((p) => t(`methods.${p.method}`)).join(' + ')}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-right font-semibold">{money(s.totalCents)}</td>
                  <td className="px-4 py-3 text-right text-xs"><SaleActions sale={s} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
