import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  IVA_OPTIONS,
  isHealthType,
  POS_METHODS,
  saleTotal,
  type PosMethod,
  type ProductDto,
  type ProductInput,
  type SaleDto,
  type StockMoveDto,
} from '@agenda/shared';
import { api } from '../lib/api';
import { useAccess, useAuth } from '../lib/auth';
import { dateTime, money, toCents } from '../lib/format';
import { useMyLocations } from '../lib/queries';
import { CustomerPicker } from './CustomerPicker';
import { InvoiceModal, useInvoicing } from './Invoicing';
import { UpgradeNote, useFeature } from './Sales';
import { ErrorText, Loading, Modal } from './ui';

/** Prescriptions only matter in health businesses (doctors, dentists…). */
const useHealth = () => {
  const { tenant } = useAuth();
  return Boolean(tenant && isHealthType(tenant.businessType));
};

type Line = { key: string; productId: string | null; name: string; qty: number; unitCents: number; rx?: boolean; max?: number | null };

/** Location picker shared by the two tabs: owners with several locations choose; others use theirs. */
function useLocationChoice() {
  const { locationId: own } = useAccess();
  const locs = useMyLocations(own);
  const [loc, setLoc] = useState(own ?? '');
  const locationId = loc || locs.list[0]?.id || '';
  const picker =
    locs.multi && !own ? (
      <select aria-label="location" className="input !w-auto" value={locationId} onChange={(e) => setLoc(e.target.value)} data-testid="pos-location">
        {locs.list.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
      </select>
    ) : null;
  return { locationId, picker };
}

const useProducts = (locationId: string, all = false, enabled = true) =>
  useQuery({
    queryKey: ['products', locationId, all],
    queryFn: () => api<ProductDto[]>(`/products?locationId=${locationId}${all ? '&all=1' : ''}`),
    enabled: enabled && Boolean(locationId),
  });

// ---------- Selling ----------

/** Counter sale: pick products (or free lines), optional customer, one or two payment methods. */
export function PosTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { manager } = useAccess();
  const health = useHealth();
  const enabled = useFeature('cash');
  const { locationId, picker } = useLocationChoice();
  const products = useProducts(locationId, false, enabled);
  const [q, setQ] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [method, setMethod] = useState<PosMethod>('cash');
  const [split, setSplit] = useState<{ method: PosMethod; amount: string } | null>(null);
  const [received, setReceived] = useState('');
  const [free, setFree] = useState<{ name: string; price: string } | null>(null);
  const [done, setDone] = useState<{ sale: SaleDto; changeCents: number } | null>(null);
  const today = format(new Date(), 'yyyy-MM-dd');
  const sales = useQuery({
    queryKey: ['sales', locationId, today],
    queryFn: () => api<SaleDto[]>(`/sales?locationId=${locationId}&from=${new Date(`${today}T00:00:00`).toISOString()}`),
    enabled: enabled && Boolean(locationId),
  });

  const total = saleTotal(lines);
  const splitCents = split ? Math.min(toCents(split.amount || '0'), total) : 0;
  const pays = split ? [{ method, amountCents: total - splitCents }, { method: split.method, amountCents: splitCents }] : [{ method, amountCents: total }];
  const cashDue = pays.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amountCents, 0);
  const changeCents = received !== '' && cashDue > 0 ? toCents(received) - cashDue : 0;

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (products.data ?? []).filter((p) => !term || [p.name, p.sku, p.category].some((x) => x?.toLowerCase().includes(term)));
  }, [products.data, q]);

  const add = (p: ProductDto) =>
    setLines((ls) => {
      const i = ls.findIndex((l) => l.productId === p.id);
      if (i >= 0) return ls.map((l, k) => (k === i ? { ...l, qty: l.qty + 1 } : l));
      return [...ls, { key: p.id, productId: p.id, name: p.name, qty: 1, unitCents: p.priceCents, rx: health && p.requiresPrescription, max: p.trackStock ? p.stock : null }];
    });
  const setQty = (key: string, qty: number) => setLines((ls) => (qty <= 0 ? ls.filter((l) => l.key !== key) : ls.map((l) => (l.key === key ? { ...l, qty } : l))));
  const reset = () => {
    setLines([]);
    setCustomerId('');
    setSplit(null);
    setReceived('');
    setMethod('cash');
  };

  const charge = useMutation({
    mutationFn: () =>
      api<SaleDto>('/sales', {
        method: 'POST',
        body: {
          locationId,
          customerId: customerId || null,
          items: lines.map((l) => (l.productId ? { productId: l.productId, qty: l.qty, unitCents: l.unitCents } : { name: l.name, qty: l.qty, unitCents: l.unitCents })),
          payments: pays.filter((p) => p.amountCents > 0 || pays.length === 1),
        },
      }),
    onSuccess: (sale) => {
      setDone({ sale, changeCents: Math.max(changeCents, 0) });
      reset();
      void qc.invalidateQueries({ queryKey: ['products'] });
      void qc.invalidateQueries({ queryKey: ['sales'] });
      void qc.invalidateQueries({ queryKey: ['payments'] });
    },
  });

  if (!enabled) return <UpgradeNote feature="cash" />;
  const shortStock = lines.find((l) => l.max != null && l.qty > l.max);
  return (
    <div className="grid items-start gap-6 lg:grid-cols-5" data-testid="pos-tab">
      <section className="card space-y-3 lg:col-span-3">
        <div className="flex flex-wrap items-center gap-2">
          <input className="input flex-1" placeholder={t('pos.search')} value={q} onChange={(e) => setQ(e.target.value)} data-testid="pos-search" />
          {picker}
          <button type="button" className="btn-secondary" onClick={() => setFree({ name: '', price: '' })}>{t('pos.freeLine')}</button>
        </div>
        {products.isLoading ? (
          <Loading />
        ) : filtered.length === 0 ? (
          <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">{(products.data ?? []).length ? t('pos.noMatch') : t('pos.noProducts')}</p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid="pos-products">
            {filtered.map((p) => {
              const out = p.trackStock && p.stock <= 0;
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    disabled={out}
                    onClick={() => add(p)}
                    className="flex h-full w-full flex-col rounded-xl border border-slate-200 bg-white p-3 text-left transition hover:border-brand-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="font-medium text-slate-900">{p.name}</span>
                    <span className="text-sm font-semibold text-brand-700">{money(p.priceCents)}</span>
                    <span className={`text-xs ${out ? 'text-rose-700' : p.low ? 'text-amber-700' : 'text-slate-500'}`}>
                      {p.trackStock ? (out ? t('pos.outOfStock') : t('pos.inStock', { n: p.stock })) : t('pos.noTracking')}
                      {health && p.requiresPrescription ? ` · ${t('pos.rx')}` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card space-y-3 lg:col-span-2" data-testid="pos-ticket">
        <h2 className="font-semibold">🧾 {t('pos.ticket')}</h2>
        {lines.length === 0 ? (
          <p className="text-sm text-slate-500">{t('pos.emptyTicket')}</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {lines.map((l) => (
              <li key={l.key} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{l.name}</div>
                  {manager ? (
                    <input
                      aria-label={t('pos.unitPrice')}
                      type="number"
                      min={0}
                      step="0.01"
                      className="input !w-28 !py-1 text-xs"
                      value={l.unitCents / 100}
                      onChange={(e) => setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, unitCents: toCents(e.target.value || '0') } : x)))}
                    />
                  ) : (
                    <div className="text-xs text-slate-500">{money(l.unitCents)}</div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" className="btn-secondary !px-2 !py-0.5" onClick={() => setQty(l.key, l.qty - 1)} aria-label="-">−</button>
                  <span className="w-6 text-center" data-testid="pos-qty">{l.qty}</span>
                  <button type="button" className="btn-secondary !px-2 !py-0.5" onClick={() => setQty(l.key, l.qty + 1)} aria-label="+">+</button>
                </div>
                <span className="w-20 text-right font-medium">{money(l.qty * l.unitCents)}</span>
              </li>
            ))}
          </ul>
        )}
        {lines.some((l) => l.rx) && <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900" data-testid="pos-rx">⚕️ {t('pos.rxNotice')}</p>}
        {shortStock && <p className="rounded-lg bg-rose-50 p-2 text-xs text-rose-700">{t('pos.notEnough', { name: shortStock.name, n: shortStock.max })}</p>}
        <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-lg font-semibold">
          <span>{t('pos.total')}</span>
          <span data-testid="pos-total">{money(total)}</span>
        </div>
        <div>
          <span className="label">{t('pos.customer')}</span>
          <CustomerPicker value={customerId} onChange={setCustomerId} forBooking={false} optional />
        </div>
        <div>
          <span className="label">{t('payments.method')}</span>
          <div className="flex flex-wrap gap-2">
            {POS_METHODS.map((m) => (
              <button key={m} type="button" className={method === m ? 'btn-primary !py-1.5' : 'btn-secondary !py-1.5'} onClick={() => setMethod(m)} data-testid={`pos-method-${m}`}>
                {t(`methods.${m}`)}
              </button>
            ))}
          </div>
        </div>
        {split ? (
          <div className="flex flex-wrap items-end gap-2 rounded-lg bg-slate-50 p-2">
            <label className="text-sm">
              <span className="label">{t('pos.splitAmount')}</span>
              <input type="number" min={0} step="0.01" className="input !w-28" value={split.amount} onChange={(e) => setSplit({ ...split, amount: e.target.value })} />
            </label>
            <select aria-label={t('payments.method')} className="input !w-auto" value={split.method} onChange={(e) => setSplit({ ...split, method: e.target.value as PosMethod })}>
              {POS_METHODS.map((m) => <option key={m} value={m}>{t(`methods.${m}`)}</option>)}
            </select>
            <button type="button" className="text-sm text-slate-500 hover:underline" onClick={() => setSplit(null)}>{t('common.cancel')}</button>
            <p className="w-full text-xs text-slate-600">{t('pos.splitRest', { amount: money(total - splitCents), method: t(`methods.${method}`) })}</p>
          </div>
        ) : (
          <button type="button" className="text-sm text-brand-700 hover:underline" onClick={() => setSplit({ method: method === 'cash' ? 'card' : 'cash', amount: '' })}>{t('pos.split')}</button>
        )}
        {cashDue > 0 && (
          <div className="flex items-end gap-3">
            <label className="text-sm">
              <span className="label">{t('pos.received')}</span>
              <input type="number" min={0} step="0.01" className="input !w-28" value={received} onChange={(e) => setReceived(e.target.value)} data-testid="pos-received" />
            </label>
            {received !== '' && (
              <div className={`pb-2 text-sm font-semibold ${changeCents < 0 ? 'text-rose-700' : 'text-emerald-700'}`} data-testid="pos-change">
                {changeCents < 0 ? t('pos.missing', { amount: money(-changeCents) }) : t('pos.change', { amount: money(changeCents) })}
              </div>
            )}
          </div>
        )}
        <ErrorText error={charge.error} ns="pos" />
        <button
          type="button"
          className="btn-primary w-full !py-3 text-base"
          disabled={!lines.length || charge.isPending || Boolean(shortStock) || (cashDue > 0 && received !== '' && changeCents < 0)}
          onClick={() => charge.mutate()}
          data-testid="pos-charge"
        >
          {charge.isPending ? t('common.loading') : t('pos.charge', { amount: money(total) })}
        </button>
      </section>

      <section className="card lg:col-span-5">
        <h2 className="mb-2 font-semibold">{t('pos.todaySales')}</h2>
        <SalesList sales={sales.data ?? []} />
        {sales.data?.length === 0 && <p className="text-sm text-slate-500">{t('pos.noSales')}</p>}
      </section>

      {free && (
        <Modal open title={t('pos.freeLine')} onClose={() => setFree(null)}>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              setLines((ls) => [...ls, { key: `free-${Date.now()}`, productId: null, name: free.name.trim(), qty: 1, unitCents: toCents(free.price || '0') }]);
              setFree(null);
            }}
          >
            <label className="block text-sm"><span className="label">{t('pos.concept')}</span><input required className="input" value={free.name} onChange={(e) => setFree({ ...free, name: e.target.value })} /></label>
            <label className="block text-sm"><span className="label">{t('pos.price')}</span><input required type="number" min={0} step="0.01" className="input" value={free.price} onChange={(e) => setFree({ ...free, price: e.target.value })} /></label>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-secondary" onClick={() => setFree(null)}>{t('common.cancel')}</button>
              <button className="btn-primary">{t('pos.addLine')}</button>
            </div>
          </form>
        </Modal>
      )}
      {done && (
        <Modal open title={t('pos.doneTitle', { n: done.sale.number })} onClose={() => setDone(null)}>
          <div className="space-y-3 text-sm" data-testid="pos-done">
            <p className="text-2xl font-semibold">{money(done.sale.totalCents)}</p>
            {done.changeCents > 0 && <p className="rounded-lg bg-emerald-50 p-3 text-lg font-semibold text-emerald-800">{t('pos.change', { amount: money(done.changeCents) })}</p>}
            <SaleActions sale={done.sale} />
            <div className="flex justify-end">
              <button type="button" className="btn-primary" onClick={() => setDone(null)}>{t('pos.newSale')}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Invoice and (for managers) cancel buttons of a sale. */
function SaleActions({ sale }: { sale: SaleDto }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { manager } = useAccess();
  const inv = useInvoicing(manager);
  const [invoicing, setInvoicing] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sales'] });
    void qc.invalidateQueries({ queryKey: ['products'] });
    void qc.invalidateQueries({ queryKey: ['payments'] });
  };
  const cancel = useMutation({ mutationFn: () => api(`/sales/${sale.id}/cancel`, { method: 'POST', body: {} }), onSuccess: refresh });
  const canInvoice = manager && inv.data?.available && inv.data.connected && sale.status === 'paid' && !sale.invoice && sale.payments[0];
  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      {sale.invoice && <span className="text-xs text-slate-600">🧾 {`${sale.invoice.series ?? ''}${sale.invoice.folio ?? ''}`}{sale.invoice.test ? ` (${t('invoicing.testShort')})` : ''}</span>}
      {canInvoice && <button type="button" className="text-brand-700 hover:underline" onClick={() => setInvoicing(true)}>{t('invoicing.issue')}</button>}
      {manager && sale.status === 'paid' && !sale.invoice && (
        <button type="button" className="text-rose-700 hover:underline" onClick={() => window.confirm(t('pos.cancelConfirm')) && cancel.mutate()} data-testid="pos-cancel">{t('pos.cancelSale')}</button>
      )}
      <ErrorText error={cancel.error} ns="pos" />
      {invoicing && sale.payments[0] && (
        <InvoiceModal
          payment={{ id: sale.payments[0].id, customerId: sale.payerCustomerId ?? '', amountCents: sale.totalCents }}
          amountCents={sale.totalCents}
          onClose={() => setInvoicing(false)}
          onDone={refresh}
        />
      )}
    </span>
  );
}

function SalesList({ sales }: { sales: SaleDto[] }) {
  const { t } = useTranslation();
  return (
    <ul className="divide-y divide-slate-100 text-sm" data-testid="pos-sales">
      {sales.map((s) => (
        <li key={s.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 ${s.status === 'canceled' ? 'opacity-50' : ''}`}>
          <div className="min-w-0">
            <div className="font-medium">
              #{s.number} · {money(s.totalCents)} {s.status === 'canceled' && <span className="text-xs text-rose-700">({t('pos.canceled')})</span>}
            </div>
            <div className="truncate text-xs text-slate-500">
              {dateTime(s.createdAt)} · {s.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}
              {s.customerName ? ` · ${s.customerName}` : ''} · {s.payments.map((p) => t(`methods.${p.method}`)).join(' + ')}
            </div>
          </div>
          <SaleActions sale={s} />
        </li>
      ))}
    </ul>
  );
}

// ---------- Catalog and stock ----------

const emptyProduct = (): ProductInput => ({ name: '', sku: null, category: null, priceCents: 0, costCents: null, trackStock: true, minStock: null, iva: '16', satKey: null, requiresPrescription: false, active: true });

/** Products with their stock at the chosen location: create, edit, receive, count, history. */
export function ProductsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { businessManager } = useAccess();
  const health = useHealth();
  const enabled = useFeature('cash');
  const { locationId, picker } = useLocationChoice();
  const products = useProducts(locationId, true, enabled);
  const [edit, setEdit] = useState<{ id: string | null; v: ProductInput } | null>(null);
  const [stock, setStock] = useState<{ p: ProductDto; mode: 'in' | 'set' } | null>(null);
  const [moves, setMoves] = useState<ProductDto | null>(null);
  const [q, setQ] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['products'] });
  const remove = useMutation({ mutationFn: (id: string) => api(`/products/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  if (!enabled) return <UpgradeNote feature="cash" />;
  const list = (products.data ?? []).filter((p) => !q.trim() || [p.name, p.sku, p.category].some((x) => x?.toLowerCase().includes(q.trim().toLowerCase())));
  const low = (products.data ?? []).filter((p) => p.active && p.low);
  return (
    <section className="card space-y-3" data-testid="products-tab">
      <div className="flex flex-wrap items-center gap-2">
        <input className="input flex-1" placeholder={t('pos.search')} value={q} onChange={(e) => setQ(e.target.value)} />
        {picker}
        {businessManager && (
          <button type="button" className="btn-primary" onClick={() => setEdit({ id: null, v: emptyProduct() })} data-testid="new-product">{t('pos.newProduct')}</button>
        )}
      </div>
      {low.length > 0 && <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900" data-testid="low-stock">⚠️ {t('pos.lowStock', { names: low.map((p) => p.name).join(', ') })}</p>}
      {products.isLoading ? (
        <Loading />
      ) : list.length === 0 ? (
        <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-600">{t('pos.noProducts')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase text-slate-500">
                <th className="py-2 pr-3">{t('pos.product')}</th>
                <th className="py-2 pr-3 text-right">{t('pos.price')}</th>
                <th className="py-2 pr-3 text-right">{t('pos.stock')}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.map((p) => (
                <tr key={p.id} className={p.active ? '' : 'opacity-50'} data-testid="product-row">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-slate-500">
                      {[p.category, p.sku, health && p.requiresPrescription ? t('pos.rx') : null, p.iva === 'exento' ? t('pos.ivaExempt') : `IVA ${p.iva}%`].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-right">{money(p.priceCents)}</td>
                  <td className={`py-2 pr-3 text-right font-semibold ${p.low ? 'text-amber-700' : ''}`}>{p.trackStock ? p.stock : '—'}</td>
                  <td className="py-2 text-right">
                    <span className="inline-flex flex-wrap justify-end gap-2 text-xs">
                      {p.trackStock && <button type="button" className="text-brand-700 hover:underline" onClick={() => setStock({ p, mode: 'in' })} data-testid="stock-in">{t('pos.receive')}</button>}
                      {p.trackStock && <button type="button" className="text-brand-700 hover:underline" onClick={() => setStock({ p, mode: 'set' })}>{t('pos.count')}</button>}
                      <button type="button" className="text-brand-700 hover:underline" onClick={() => setMoves(p)}>{t('pos.history')}</button>
                      {businessManager && <button type="button" className="text-brand-700 hover:underline" onClick={() => setEdit({ id: p.id, v: { ...p } })}>{t('common.edit')}</button>}
                      {businessManager && p.active && <button type="button" className="text-rose-700 hover:underline" onClick={() => window.confirm(t('pos.deleteConfirm')) && remove.mutate(p.id)}>{t('common.delete')}</button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorText error={remove.error} />
      {edit && <ProductModal value={edit.v} id={edit.id} locationId={locationId} onClose={() => setEdit(null)} onDone={refresh} />}
      {stock && <StockModal product={stock.p} mode={stock.mode} locationId={locationId} onClose={() => setStock(null)} onDone={refresh} />}
      {moves && <MovesModal product={moves} locationId={locationId} onClose={() => setMoves(null)} />}
    </section>
  );
}

function ProductModal({ value, id, locationId, onClose, onDone }: { value: ProductInput; id: string | null; locationId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const health = useHealth();
  const [v, setV] = useState<ProductInput>(value);
  const [price, setPrice] = useState(value.priceCents ? String(value.priceCents / 100) : '');
  const [cost, setCost] = useState(value.costCents != null ? String(value.costCents / 100) : '');
  const [initial, setInitial] = useState('');
  const set = (p: Partial<ProductInput>) => setV({ ...v, ...p });
  const save = useMutation({
    mutationFn: () => {
      const body: ProductInput = {
        name: v.name,
        sku: v.sku || null,
        category: v.category || null,
        priceCents: toCents(price || '0'),
        costCents: cost === '' ? null : toCents(cost),
        trackStock: v.trackStock,
        minStock: v.minStock ?? null,
        iva: v.iva,
        satKey: v.satKey || null,
        requiresPrescription: health && Boolean(v.requiresPrescription),
        active: v.active,
        ...(id ? {} : { initialStock: initial === '' ? undefined : Number(initial), locationId }),
      };
      return api(id ? `/products/${id}` : '/products', { method: id ? 'PUT' : 'POST', body });
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal open title={id ? t('pos.editProduct') : t('pos.newProduct')} onClose={onClose}>
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} data-testid="product-form">
        <label className="block text-sm sm:col-span-2"><span className="label">{t('pos.product')}</span><input required className="input" value={v.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <label className="block text-sm"><span className="label">{t('pos.price')}</span><input required type="number" min={0} step="0.01" className="input" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
        <label className="block text-sm"><span className="label">{t('pos.cost')}</span><input type="number" min={0} step="0.01" className="input" value={cost} onChange={(e) => setCost(e.target.value)} /></label>
        <label className="block text-sm"><span className="label">{t('pos.category')}</span><input className="input" value={v.category ?? ''} onChange={(e) => set({ category: e.target.value })} /></label>
        <label className="block text-sm"><span className="label">{t('pos.sku')}</span><input className="input" value={v.sku ?? ''} onChange={(e) => set({ sku: e.target.value })} /></label>
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={v.trackStock !== false} onChange={(e) => set({ trackStock: e.target.checked })} /> {t('pos.trackStock')}</label>
        {v.trackStock !== false && (
          <>
            {!id && <label className="block text-sm"><span className="label">{t('pos.initialStock')}</span><input type="number" min={0} className="input" value={initial} onChange={(e) => setInitial(e.target.value)} /></label>}
            <label className="block text-sm"><span className="label">{t('pos.minStock')}</span><input type="number" min={0} className="input" value={v.minStock ?? ''} onChange={(e) => set({ minStock: e.target.value === '' ? null : Number(e.target.value) })} /></label>
          </>
        )}
        <label className="block text-sm">
          <span className="label">IVA</span>
          <select className="input" value={v.iva ?? '16'} onChange={(e) => set({ iva: e.target.value as ProductInput['iva'] })}>
            {IVA_OPTIONS.map((x) => <option key={x} value={x}>{t(`invoicing.iva.${x}`)}</option>)}
          </select>
        </label>
        <label className="block text-sm"><span className="label">{t('pos.satKey')}</span><input className="input font-mono" inputMode="numeric" maxLength={8} placeholder="01010101" value={v.satKey ?? ''} onChange={(e) => set({ satKey: e.target.value.replace(/\D/g, '') })} /></label>
        {health && (
          <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={Boolean(v.requiresPrescription)} onChange={(e) => set({ requiresPrescription: e.target.checked })} /> {t('pos.requiresRx')}</label>
        )}
        {id && <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={v.active !== false} onChange={(e) => set({ active: e.target.checked })} /> {t('pos.active')}</label>}
        <div className="sm:col-span-2"><ErrorText error={save.error} ns="pos" /></div>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={save.isPending}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  );
}

function StockModal({ product, mode, locationId, onClose, onDone }: { product: ProductDto; mode: 'in' | 'set'; locationId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [qty, setQty] = useState('');
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () => api(`/products/${product.id}/stock`, { method: 'POST', body: { locationId, mode, qty: Number(qty), note: note || null } }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal open title={`${mode === 'in' ? t('pos.receive') : t('pos.count')} · ${product.name}`} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} data-testid="stock-form">
        <p className="text-sm text-slate-600">{t('pos.onHand', { n: product.stock })}</p>
        <label className="block text-sm"><span className="label">{mode === 'in' ? t('pos.unitsIn') : t('pos.unitsCounted')}</span><input required type="number" min={0} className="input" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
        <input className="input" placeholder={t('pos.note')} value={note} onChange={(e) => setNote(e.target.value)} />
        <ErrorText error={save.error} ns="pos" />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={save.isPending}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  );
}

function MovesModal({ product, locationId, onClose }: { product: ProductDto; locationId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['stock-moves', product.id, locationId], queryFn: () => api<StockMoveDto[]>(`/products/${product.id}/moves?locationId=${locationId}`) });
  return (
    <Modal open title={`${t('pos.history')} · ${product.name}`} onClose={onClose}>
      {q.isLoading ? (
        <Loading />
      ) : (
        <ul className="divide-y divide-slate-100 text-sm">
          {(q.data ?? []).map((m) => (
            <li key={m.id} className="flex justify-between gap-2 py-2">
              <div>
                <div>{t(`pos.reason.${m.reason}`)}{m.saleNumber ? ` #${m.saleNumber}` : ''}{m.note ? ` · ${m.note}` : ''}</div>
                <div className="text-xs text-slate-500">{dateTime(m.createdAt)}{m.createdByName ? ` · ${m.createdByName}` : ''}</div>
              </div>
              <div className="text-right">
                <div className={`font-semibold ${m.qtyChange < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{m.qtyChange > 0 ? '+' : ''}{m.qtyChange}</div>
                <div className="text-xs text-slate-500">{t('pos.left', { n: m.qtyAfter })}</div>
              </div>
            </li>
          ))}
          {q.data?.length === 0 && <li className="py-2 text-slate-500">{t('pos.noMoves')}</li>}
        </ul>
      )}
    </Modal>
  );
}

/** Punto de venta in the menu: selling, and the catalog for managers. */
export function PosPage() {
  const { t } = useTranslation();
  const { manager } = useAccess();
  const [tab, setTab] = useState<'sell' | 'products'>(() => (new URLSearchParams(window.location.search).get('tab') === 'products' ? 'products' : 'sell'));
  const btn = (k: 'sell' | 'products') => `rounded-md px-3 py-1 text-sm font-medium ${tab === k ? 'bg-brand-700 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`;
  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-slate-900">{t('nav.pos')}</h1>
        {manager && (
          <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'sell'} className={btn('sell')} onClick={() => setTab('sell')}>{t('payments.tabs.pos')}</button>
            <button type="button" role="tab" aria-selected={tab === 'products'} className={btn('products')} onClick={() => setTab('products')}>{t('payments.tabs.products')}</button>
          </div>
        )}
      </div>
      {tab === 'products' && manager ? <ProductsTab /> : <PosTab />}
    </>
  );
}
