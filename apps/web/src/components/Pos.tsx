import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IVA_OPTIONS,
  isHealthType,
  POS_METHODS,
  saleTotal,
  type PosMethod,
  type BusinessSummary,
  type PosHeaderDto,
  type ProductDto,
  type ProductInput,
  type SaleDto,
  type SessionUser,
  type StockMoveDto,
  type TenantDto,
} from '@agenda/shared';
import { api, ApiError } from '../lib/api';
import {
  addPending,
  dropPending,
  releasePending,
  flushPending,
  isNetworkError,
  isRegister,
  loadCatalog,
  loadLocation,
  loadTickets,
  markOnline,
  offlineExpired,
  recordSent,
  retryPending,
  saveCatalog,
  saveHeader,
  saveLocation,
  saveSession,
  saveTickets,
  subscribe,
  takeFromCatalog,
  uuid,
  type OpenTicket,
  type PendingSale,
} from '../lib/offlinePos';
import { useOnline, useRegister } from '../lib/usePosOffline';
import { useAccess, useAuth } from '../lib/auth';
import { dateTime, money, toCents } from '../lib/format';
import { useMyLocations } from '../lib/queries';
import { CustomerPicker } from './CustomerPicker';
import { InvoiceModal, useInvoicing } from './Invoicing';
import { UpgradeNote, useFeature } from './Sales';
import { openTicket } from '../pages/Ticket';
import { Empty, ErrorText, Loading, Modal, Switch } from './ui';
import { EditableCell, ImportModal, downloadInventory } from './Inventory';
import { FILTER_CTRL, TOOLBAR_BTN } from './FilterBar';
import { DataTable, useColumns } from './Columns';
import { CameraScanModal, CategoryField, SatKeyField, cameraScanAvailable, suggestSku, useScannerInput } from './ProductFields';
import { PosSettingsModal, useCategoryList, usePosSettings } from './PosSettings';

/** Prescriptions only matter in health businesses (doctors, dentists…). */
const useHealth = () => {
  const { tenant } = useAuth();
  return Boolean(tenant && isHealthType(tenant.businessType));
};

type Line = OpenTicket['lines'][number];
type Done = { sale: SaleDto | null; pending: PendingSale | null; changeCents: number; invoice?: boolean };

/**
 * The location this counter sells at: chosen once per sign-in (in the Punto de venta header) and
 * kept on this computer; people tied to one location always use theirs.
 */
export function useLocationChoice() {
  const { locationId: own } = useAccess();
  const { tenant } = useAuth();
  const locs = useMyLocations(own);
  const saved = useSyncExternalStore(subscribe, () => (tenant ? loadLocation(tenant.id) : ''));
  const savedOk = locs.list.some((l) => l.id === saved);
  // Without internet the list doesn't load: the register's last location
  const locationId = own ?? (savedOk ? saved : locs.list.length ? (locs.multi ? saved || locs.list[0]!.id : locs.list[0]!.id) : saved);
  const choose = (id: string) => tenant && saveLocation(tenant.id, id);
  useEffect(() => {
    // One location: nothing to choose
    if (tenant && !locs.multi && locs.list[0] && saved !== locs.list[0].id) saveLocation(tenant.id, locs.list[0].id);
  }, [tenant, locs.multi, locs.list, saved]);
  return {
    locationId,
    locationName: locs.multi ? locs.list.find((l) => l.id === locationId)?.name ?? null : null,
    /** Several locations and none chosen yet on this computer */
    needsChoice: locs.multi && !own && !savedOk && !locs.isLoading,
    canChoose: locs.multi && !own,
    locations: locs.list,
    choose,
  };
}

/** The counter's location in the Punto de venta header: asked once, changed rarely. */
export function PosLocation() {
  const { t } = useTranslation();
  const { locationName, needsChoice, canChoose, locations, choose, locationId } = useLocationChoice();
  const [open, setOpen] = useState(false);
  if (!canChoose) return null;
  return (
    <>
      <button type="button" className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-brand-400" onClick={() => setOpen(true)} data-testid="pos-location">
        📍 <span className="font-medium">{locationName}</span>
        <span className="text-xs text-brand-700">{t('pos.location.change')}</span>
      </button>
      {(open || needsChoice) && (
        <Modal open title={t('pos.location.title')} onClose={() => (needsChoice ? undefined : setOpen(false))}>
          <p className="mb-3 text-sm text-slate-600">{t('pos.location.help')}</p>
          <ul className="space-y-2" data-testid="pos-location-choices">
            {locations.map((l) => (
              <li key={l.id}>
                <button
                  type="button"
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${l.id === locationId && !needsChoice ? 'border-brand-600 bg-brand-50 font-medium' : 'border-slate-200 hover:border-brand-400'}`}
                  onClick={() => {
                    choose(l.id);
                    setOpen(false);
                  }}
                >
                  {l.name}
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </>
  );
}

const useProducts = (locationId: string, all = false, enabled = true) => {
  const { tenant } = useAuth();
  const register = isRegister(tenant?.id);
  return useQuery({
    queryKey: ['products', locationId, all],
    queryFn: async () => {
      try {
        const list = await api<ProductDto[]>(`/products?locationId=${locationId}${all ? '&all=1' : ''}`);
        if (register && !all && tenant) {
          saveCatalog(tenant.id, locationId, list);
          markOnline(tenant.id);
        }
        return list;
      } catch (e) {
        // A register sells from its copy of the catalog while there's no internet
        const copy = register && !all && tenant && isNetworkError(e) ? loadCatalog(tenant.id, locationId) : null;
        if (copy) return copy;
        throw e;
      }
    },
    enabled: enabled && Boolean(locationId),
    // React Query pauses requests offline by default; a register answers from its copy
    networkMode: register ? 'always' : 'online',
  });
};

const newTicket = (): OpenTicket => ({ id: uuid(), lines: [], customerId: '', customerName: null, createdAt: new Date().toISOString() });

/**
 * Open tickets of a location: serve the next customer while another one decides. Kept on the
 * device so a reload (or a cut) doesn't lose them.
 */
function useOpenTickets(tenantId: string | undefined, locationId: string) {
  const load = () => {
    const list = tenantId && locationId ? loadTickets(tenantId, locationId) : [];
    return list.length ? list : [newTicket()];
  };
  const [tickets, setTickets] = useState<OpenTicket[]>(load);
  const [activeId, setActiveId] = useState(() => tickets[0]!.id);
  useEffect(() => {
    const list = load();
    setTickets(list);
    setActiveId(list[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, locationId]);
  const save = (list: OpenTicket[]) => {
    setTickets(list);
    if (tenantId && locationId) saveTickets(tenantId, locationId, list.filter((t) => t.lines.length || t.customerId));
  };
  const active = tickets.find((t) => t.id === activeId) ?? tickets[0]!;
  return {
    tickets,
    active,
    select: (id: string) => setActiveId(id),
    update: (fn: (t: OpenTicket) => OpenTicket) => save(tickets.map((t) => (t.id === active.id ? fn(t) : t))),
    add: () => {
      const t = newTicket();
      save([...tickets, t]);
      setActiveId(t.id);
    },
    /** Takes a ticket away (charged or discarded) and moves to another one */
    remove: (id: string) => {
      const rest = tickets.filter((t) => t.id !== id);
      const list = rest.length ? rest : [newTicket()];
      save(list);
      if (id === activeId || !rest.length) setActiveId(list[list.length - 1]!.id);
    },
  };
}

// ---------- Selling ----------

/** Counter sale: pick products (or free lines), optional customer, one or two payment methods. */
export function PosTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { manager, businessManager } = useAccess();
  const { user } = useAuth();
  const health = useHealth();
  const enabled = useFeature('cash');
  const { locationId } = useLocationChoice();
  const reg = useRegister();
  const tenantId = reg.tenantId;
  const online = useOnline();
  const products = useProducts(locationId, false, enabled);
  const open = useOpenTickets(tenantId, locationId);
  const lines = open.active.lines;
  const customerId = open.active.customerId;
  const setLines = (fn: (ls: Line[]) => Line[]) => open.update((tk) => ({ ...tk, lines: fn(tk.lines) }));
  const setCustomerId = (id: string, c?: { name: string }) => open.update((tk) => ({ ...tk, customerId: id, customerName: id ? (c?.name ?? tk.customerName) : null }));
  const [q, setQ] = useState('');
  // No method chosen until the seller picks one (avoids charging cash by mistake)
  const [method, setMethod] = useState<PosMethod | null>(null);
  const [showCustomer, setShowCustomer] = useState(false);
  const [split, setSplit] = useState<{ method: PosMethod; amount: string } | null>(null);
  const [received, setReceived] = useState('');
  const [free, setFree] = useState<{ name: string; price: string } | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [discard, setDiscard] = useState<string | null>(null);
  // With invoicing on, "Cobrar" first asks whether this sale gets a factura
  const inv = useInvoicing(manager);
  const invoicingOn = Boolean(manager && online && inv.data?.available && inv.data.connected);
  const [askInvoice, setAskInvoice] = useState(false);
  const wantInvoice = useRef(false);
  const doCharge = (withInvoice: boolean) => {
    wantInvoice.current = withInvoice;
    setAskInvoice(false);
    charge.mutate(autoPrint ? window.open('', '_blank') : null);
  };
  const [autoPrint, setAutoPrint] = useState(() => {
    try {
      return localStorage.getItem('agenda.pos.autoPrint') === '1';
    } catch {
      return false;
    }
  });
  const toggleAutoPrint = (v: boolean) => {
    setAutoPrint(v);
    try {
      localStorage.setItem('agenda.pos.autoPrint', v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  // Ready to sell without internet: keep the session so the app opens offline
  useEffect(() => {
    if (reg.on && tenantId && navigator.onLine) {
      void api<{ user: SessionUser; tenant: TenantDto; businesses: BusinessSummary[] }>('/auth/me').then(saveSession).catch(() => undefined);
    }
  }, [reg.on, tenantId]);
  // The register keeps the ticket header (business name, address…) to print offline
  useQuery({
    queryKey: ['pos-header', locationId],
    queryFn: async () => {
      const h = await api<PosHeaderDto>(`/pos/header?locationId=${locationId}`);
      if (tenantId) saveHeader(tenantId, locationId, h);
      return h;
    },
    enabled: enabled && reg.on && online && Boolean(locationId),
    staleTime: 10 * 60_000,
  });

  const total = saleTotal(lines);
  const splitCents = split ? Math.min(toCents(split.amount || '0'), total) : 0;
  const pays = !method ? [] : split ? [{ method, amountCents: total - splitCents }, { method: split.method, amountCents: splitCents }] : [{ method, amountCents: total }];
  const cashDue = pays.filter((p) => p.method === 'cash').reduce((a, p) => a + p.amountCents, 0);
  const changeCents = received !== '' && cashDue > 0 ? toCents(received) - cashDue : 0;

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (products.data ?? []).filter((p) => !term || [p.name, p.sku, p.category].some((x) => x?.toLowerCase().includes(term)));
  }, [products.data, q]);

  // "×10" before clicking or scanning adds 10 at once (then back to 1)
  const [mult, setMult] = useState('');
  const take = (n?: number) => {
    const m = n ?? Math.max(1, Math.min(9999, Math.floor(Number(mult) || 1)));
    setMult('');
    return m;
  };
  const add = (p: ProductDto, n?: number) => {
    const by = take(n);
    setLines((ls) => {
      const i = ls.findIndex((l) => l.productId === p.id);
      if (i >= 0) return ls.map((l, k) => (k === i ? { ...l, qty: l.qty + by } : l));
      return [...ls, { key: p.id, productId: p.id, name: p.name, qty: by, unitCents: p.priceCents, rx: health && p.requiresPrescription, max: p.trackStock ? p.stock : null }];
    });
  };
  const setQty = (key: string, qty: number) => setLines((ls) => (qty <= 0 ? ls.filter((l) => l.key !== key) : ls.map((l) => (l.key === key ? { ...l, qty } : l))));
  const { stockPolicy } = usePosSettings();
  const categoryList = useCategoryList(products.data);
  // Newly added products show at the bottom of the ticket: keep it in view
  const cartList = useRef<HTMLUListElement>(null);
  const lineCount = lines.length;
  useEffect(() => {
    const el = cartList.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lineCount]);
  const offlineNow = !online || (reg.on && products.isError);
  // Barcode: a scanner (or typing the code + Enter) adds the product with that SKU
  const [scanMsg, setScanMsg] = useState<{ text: string; code?: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const addByCode = (raw: string) => {
    // "10*7501234567890": ten of that product
    const m = /^(\d{1,4})\s*[x*]\s*(.+)$/i.exec(raw.trim());
    const code = (m ? m[2]! : raw).trim();
    const c = code.toLowerCase();
    const p = (products.data ?? []).find((x) => x.sku?.trim().toLowerCase() === c);
    if (!p) {
      setScanMsg({ text: t('pos.scan.notFound', { code }), code });
      return false;
    }
    if (p.trackStock && p.stock <= 0 && stockPolicy === 'block' && !(offlineNow && reg.on)) {
      setScanMsg({ text: t('pos.scan.noStock', { name: p.name }) });
      return true;
    }
    setScanMsg(null);
    add(p, m ? Math.max(1, Number(m[1])) : undefined);
    return true;
  };
  useScannerInput(addByCode, enabled);
  const resetPayment = () => {
    setSplit(null);
    setReceived('');
    setMethod(null);
    setShowCustomer(false);
  };
  const switchTo = (id: string) => {
    open.select(id);
    resetPayment();
    setAskInvoice(false);
    setDiscard(null);
  };

  const charge = useMutation({
    // Don't wait for the connection: a register charges offline
    networkMode: 'always',
    // `win`: a window opened on the click (browsers block opening one later) for the ticket
    mutationFn: async (_win: Window | null): Promise<Done> => {
      const clientId = uuid();
      const soldAt = new Date().toISOString();
      const payments = pays.filter((p) => p.amountCents > 0 || pays.length === 1);
      const body = {
        locationId,
        customerId: customerId || null,
        items: lines.map((l) => (l.productId ? { productId: l.productId, name: l.name, qty: l.qty, unitCents: l.unitCents } : { name: l.name, qty: l.qty, unitCents: l.unitCents })),
        payments,
        clientId,
      };
      const done = { sale: null, pending: null, changeCents: Math.max(changeCents, 0) };
      if (!reg.on || !tenantId) return { ...done, sale: await api<SaleDto>('/sales', { method: 'POST', body }) };
      // A register writes the sale down first: if the answer is lost, it's uploaded later
      const pending = addPending(tenantId, {
        clientId, locationId, soldAt, body,
        items: lines.map((l) => ({ name: l.name, qty: l.qty, unitCents: l.unitCents, totalCents: l.qty * l.unitCents })),
        payments, totalCents: total, customerName: customerId ? open.active.customerName : null, createdByName: user?.name ?? null,
      });
      const keepOffline = (): Done => {
        if (offlineExpired(tenantId)) {
          dropPending(tenantId, clientId);
          throw new ApiError(0, 'offline_expired');
        }
        takeFromCatalog(tenantId, locationId, lines);
        void qc.invalidateQueries({ queryKey: ['products'] });
        return { ...done, pending };
      };
      if (!navigator.onLine) return keepOffline();
      try {
        const sale = await api<SaleDto>('/sales', { method: 'POST', body });
        recordSent(tenantId, clientId, sale.id);
        releasePending(tenantId, clientId);
        markOnline(tenantId);
        return { ...done, sale };
      } catch (e) {
        if (isNetworkError(e)) return keepOffline();
        dropPending(tenantId, clientId);
        throw e;
      }
    },
    onSuccess: (d, win) => {
      if (win) {
        if (d.sale) openTicket(d.sale.id, { print: true, changeCents: d.changeCents, win });
        else if (d.pending) openTicket(d.pending.clientId, { print: true, changeCents: d.changeCents, win, local: true });
      }
      setDone({ ...d, invoice: wantInvoice.current && Boolean(d.sale) });
      wantInvoice.current = false;
      open.remove(open.active.id);
      resetPayment();
      void qc.invalidateQueries({ queryKey: ['products'] });
      void qc.invalidateQueries({ queryKey: ['sales'] });
      void qc.invalidateQueries({ queryKey: ['payments'] });
    },
    onError: (_e, win) => win?.close(),
  });

  if (!enabled) return <UpgradeNote feature="cash" />;
  // Without stock: stop the sale, warn, or let it go (business setting); offline it's checked on upload
  const over = !online && reg.on ? undefined : lines.find((l) => l.max != null && l.qty > l.max);
  const shortStock = stockPolicy === 'block' ? over : undefined;
  const lowWarn = stockPolicy === 'warn' ? over : undefined;
  return (
    <div className="grid items-start gap-6 lg:grid-cols-5" data-testid="pos-tab">
      <OfflineBar online={online} register={reg.on} pending={reg.pending} tenantId={tenantId} />
      <section className="card space-y-3 lg:col-span-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center rounded-lg border border-slate-300 bg-white pl-2 text-sm text-slate-500" title={t('pos.multHelp')}>
            ×
            <input
              className="w-12 border-0 bg-transparent px-1 py-2 text-sm text-slate-900 focus:outline-none focus:ring-0"
              inputMode="numeric"
              placeholder="1"
              aria-label={t('pos.multHelp')}
              value={mult}
              onChange={(e) => setMult(e.target.value.replace(/\D/g, '').slice(0, 4))}
              data-testid="pos-mult"
            />
          </label>
          <input
            className="input flex-1"
            placeholder={t('pos.searchOrScan')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setScanMsg(null);
            }}
            onKeyDown={(e) => {
              // Scanners type the code and press Enter: add it right away
              if (e.key === 'Enter' && q.trim()) {
                e.preventDefault();
                if (addByCode(q)) setQ('');
                else if (filtered.length === 1) {
                  add(filtered[0]!);
                  setQ('');
                  setScanMsg(null);
                }
              }
            }}
            data-testid="pos-search"
          />
          {cameraScanAvailable() && (
            <button type="button" className="btn-secondary" title={t('pos.scan.button')} aria-label={t('pos.scan.button')} onClick={() => setScanning(true)} data-testid="pos-scan">📷</button>
          )}
          <button type="button" className="btn-secondary" onClick={() => setFree({ name: '', price: '' })}>{t('pos.freeLine')}</button>
        </div>
        {scanMsg && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900" data-testid="pos-scan-msg">
            <span className="flex-1">{scanMsg.text}</span>
            {scanMsg.code && businessManager && online && (
              <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => { setCreating(scanMsg.code!); setScanMsg(null); }} data-testid="pos-create-from-code">
                + {t('pos.scan.create')}
              </button>
            )}
          </div>
        )}
        {creating !== null && (
          <ProductModal
            value={{ ...emptyProduct(), sku: creating }}
            id={null}
            locationId={locationId}
            categories={categoryList}
            skus={(products.data ?? []).filter((p) => p.sku).map((p) => p.sku!)}
            lookup={creating}
            onClose={() => setCreating(null)}
            onDone={() => void qc.invalidateQueries({ queryKey: ['products'] })}
          />
        )}
        {scanning && <CameraScanModal onCode={(code) => { setScanning(false); addByCode(code); }} onClose={() => setScanning(false)} />}
        {products.isLoading ? (
          <Loading />
        ) : products.isError && !products.data ? (
          <p className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900">{reg.on ? t('pos.offline.noCatalog') : t('pos.offline.needRegister')}</p>
        ) : filtered.length === 0 ? (
          <Empty compact>{(products.data ?? []).length ? t('pos.noMatch') : t('pos.noProducts')}</Empty>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid="pos-products">
            {filtered.map((p) => {
              // Offline the copy of stock may be behind: let the register sell (it's checked on upload)
              const out = p.trackStock && p.stock <= 0 && stockPolicy === 'block' && !(offlineNow && reg.on);
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
                    <span className={`text-xs ${p.trackStock && p.stock <= 0 ? 'text-rose-700' : p.low ? 'text-amber-700' : 'text-slate-500'}`}>
                      {p.trackStock ? (p.stock <= 0 ? t('pos.outOfStock') : t('pos.inStock', { n: p.stock })) : t('pos.noTracking')}
                      {health && p.requiresPrescription ? ` · ${t('pos.rx')}` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card flex flex-col gap-3 lg:sticky lg:top-4 lg:col-span-2 lg:max-h-[calc(100vh-2rem)]" data-testid="pos-ticket">
        <div className="no-scrollbar -mx-1 flex shrink-0 items-center gap-1.5 overflow-x-auto px-1 pb-0.5" data-testid="pos-tickets">
          {open.tickets.map((tk, i) => {
            const isActive = tk.id === open.active.id;
            const sum = saleTotal(tk.lines);
            return (
              <span key={tk.id} className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-lg border text-sm ${isActive ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-200 bg-white text-slate-700'}`}>
                <button type="button" className="px-2.5 py-1 font-medium" onClick={() => switchTo(tk.id)} aria-pressed={isActive} data-testid="pos-ticket-tab">
                  {tk.customerId && tk.customerName ? (
                    <span className="inline-block max-w-[9rem] truncate align-bottom" title={tk.customerName} data-testid="pos-ticket-customer">{tk.customerName}</span>
                  ) : (
                    t('pos.tickets.label', { n: i + 1 })
                  )}
                  {tk.lines.length ? ` · ${money(sum)}` : ''}
                </button>
                {open.tickets.length > 1 &&
                  (discard === tk.id ? (
                    <button type="button" className="px-2 py-1 text-xs font-semibold text-rose-700" onClick={() => { open.remove(tk.id); setDiscard(null); resetPayment(); }} data-testid="pos-ticket-discard-yes">
                      {t('pos.tickets.discardSure')}
                    </button>
                  ) : (
                    <button type="button" className="px-1.5 py-1 text-slate-400 hover:text-rose-700" aria-label={t('pos.tickets.discard')} onClick={() => (tk.lines.length ? setDiscard(tk.id) : open.remove(tk.id))} data-testid="pos-ticket-discard">
                      ✕
                    </button>
                  ))}
              </span>
            );
          })}
          <button type="button" className="shrink-0 whitespace-nowrap rounded-lg border border-dashed border-slate-300 px-2.5 py-1 text-sm text-brand-700 hover:border-brand-400" onClick={() => { open.add(); resetPayment(); }} data-testid="pos-new-ticket">
            + {t('pos.tickets.new')}
          </button>
        </div>
        {lines.length === 0 ? (
          <p className="text-sm text-slate-500">{open.tickets.length > 1 ? t('pos.tickets.empty') : t('pos.emptyTicket')}</p>
        ) : (
          <>
          <ul ref={cartList} className="-mr-2 max-h-[40vh] min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto pr-2 text-sm lg:max-h-none" data-testid="pos-cart">
            {lines.map((l) => (
              <li key={l.key} className="flex items-center gap-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium" title={l.name}>{l.name}</div>
                  {l.qty > 1 && <div className="text-xs text-slate-500">{money(l.unitCents)} c/u</div>}
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" className="btn-secondary !px-2 !py-0.5" onClick={() => setQty(l.key, l.qty - 1)} aria-label="-">−</button>
                  <EditableCell
                    value={String(l.qty)}
                    display={<span className="inline-block min-w-[1.5rem] text-center">{l.qty}</span>}
                    parse={(v) => { const n = Number(v.trim()); return Number.isInteger(n) && n >= 0 && n <= 9999 ? n : null; }}
                    onSave={async (n) => { if (n != null) setQty(l.key, n); }}
                    canEdit
                    inputMode="numeric"
                    className="!w-14 text-center"
                    testId="pos-qty"
                  />
                  <button type="button" className="btn-secondary !px-2 !py-0.5" onClick={() => setQty(l.key, l.qty + 1)} aria-label="+">+</button>
                </div>
                <span className="w-20 text-right font-semibold">
                  <EditableCell
                    value={String(l.unitCents / 100)}
                    display={money(l.qty * l.unitCents)}
                    parse={(v) => { const n = Number(v.replace(/[$,\s]/g, '')); return v.trim() !== '' && Number.isFinite(n) && n >= 0 ? toCents(String(n)) : null; }}
                    onSave={async (unitCents) => { if (unitCents != null) setLines((ls) => ls.map((x) => (x.key === l.key ? { ...x, unitCents } : x))); }}
                    canEdit={manager}
                    inputMode="decimal"
                    className="!w-20 text-right"
                    testId="pos-line-price"
                  />
                </span>
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-slate-400 hover:bg-rose-50 hover:text-rose-700"
                  aria-label={t('pos.removeLine', { name: l.name })}
                  title={t('pos.removeLine', { name: l.name })}
                  onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                  data-testid="pos-remove-line"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          {manager && <p className="-mt-1 text-[11px] text-slate-400">{t('pos.cartHint')}</p>}
          </>
        )}
        {lines.some((l) => l.rx) && <p className="shrink-0 rounded-lg bg-amber-50 p-2 text-xs text-amber-900" data-testid="pos-rx">⚕️ {t('pos.rxNotice')}</p>}
        {shortStock && <p className="shrink-0 rounded-lg bg-rose-50 p-2 text-xs text-rose-700">{t('pos.notEnough', { name: shortStock.name, n: shortStock.max })}</p>}
        {lowWarn && <p className="shrink-0 rounded-lg bg-amber-50 p-2 text-xs text-amber-900" data-testid="pos-stock-warn">{t('pos.stockWarn', { name: lowWarn.name, n: lowWarn.max })}</p>}
        <div className="shrink-0 space-y-2.5 border-t border-slate-100 pt-2">
          <div className="flex items-center justify-between text-lg font-semibold">
            <span>{t('pos.total')}</span>
            <span data-testid="pos-total">{money(total)}</span>
          </div>
          <div>
            <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label={t('payments.method')}>
              {POS_METHODS.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={method === m}
                  title={t(`methods.${m}`)}
                  className={`rounded-lg border px-1 py-2 text-xs font-medium leading-tight sm:text-sm ${method === m ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white text-slate-700 hover:border-brand-400'}`}
                  onClick={() => {
                    setMethod(m);
                    if (m !== 'cash' && !split) setReceived('');
                  }}
                  data-testid={`pos-method-${m}`}
                >
                  {t(`pos.methodShort.${m}`)}
                </button>
              ))}
            </div>
            {split ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-2 text-sm">
                <input type="number" min={0} step="0.01" aria-label={t('pos.splitAmount')} placeholder={t('pos.splitAmount')} className="input !h-9 !w-28 !py-1" value={split.amount} onChange={(e) => setSplit({ ...split, amount: e.target.value })} />
                <select aria-label={t('payments.method')} className="input !h-9 !w-auto !py-1" value={split.method} onChange={(e) => setSplit({ ...split, method: e.target.value as PosMethod })}>
                  {POS_METHODS.map((m) => <option key={m} value={m}>{t(`methods.${m}`)}</option>)}
                </select>
                <button type="button" className="text-xs text-slate-500 hover:underline" onClick={() => setSplit(null)}>{t('common.cancel')}</button>
                {method && <p className="w-full text-xs text-slate-600">{t('pos.splitRest', { amount: money(total - splitCents), method: t(`methods.${method}`) })}</p>}
              </div>
            ) : null}
          </div>
          {cashDue > 0 && (
            <div className="flex items-center gap-3 text-sm">
              <label className="flex items-center gap-2">
                <span className="text-slate-600">{t('pos.received')}</span>
                <input type="number" min={0} step="0.01" className="input !h-9 !w-28 !py-1" value={received} onChange={(e) => setReceived(e.target.value)} data-testid="pos-received" />
              </label>
              {received !== '' && (
                <span className={`font-semibold ${changeCents < 0 ? 'text-rose-700' : 'text-emerald-700'}`} data-testid="pos-change">
                  {changeCents < 0 ? t('pos.missing', { amount: money(-changeCents) }) : t('pos.change', { amount: money(changeCents) })}
                </span>
              )}
            </div>
          )}
          <ErrorText error={charge.error} ns="pos" />
          <button
            type="button"
            className="btn-primary w-full !py-3 text-base"
            disabled={!lines.length || !method || charge.isPending || Boolean(shortStock) || (cashDue > 0 && received !== '' && changeCents < 0)}
            onClick={() => (invoicingOn ? setAskInvoice(true) : doCharge(false))}
            data-testid="pos-charge"
          >
            {charge.isPending ? t('common.loading') : lines.length && !method ? t('pos.pickMethod') : t('pos.charge', { amount: money(total) })}
          </button>
          {askInvoice && !charge.isPending && (
            <div className="space-y-2 rounded-lg border border-brand-200 bg-brand-50 p-3" data-testid="pos-ask-invoice">
              <p className="text-sm font-medium text-slate-800">{t('pos.askInvoice')}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-primary" onClick={() => doCharge(true)} data-testid="pos-invoice-yes">{t('pos.invoiceYes')}</button>
                <button type="button" className="btn-secondary" onClick={() => doCharge(false)} data-testid="pos-invoice-no">{t('pos.invoiceNo')}</button>
                <button type="button" className="text-sm text-slate-500 hover:underline" onClick={() => setAskInvoice(false)}>{t('common.cancel')}</button>
              </div>
            </div>
          )}
          {/* Optional extras, out of the way: customer, split, auto print */}
          {(showCustomer || customerId) && !offlineNow && (
            <div data-testid="pos-customer">
              <CustomerPicker key={open.active.id} value={customerId} valueName={open.active.customerName} onChange={setCustomerId} forBooking={false} optional />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
            {!showCustomer && !customerId && (
              offlineNow ? (
                <span className="text-slate-500">{t('pos.offline.noCustomer')}</span>
              ) : (
                <button type="button" className="text-brand-700 hover:underline" onClick={() => setShowCustomer(true)} data-testid="pos-add-customer">+ {t('pos.addCustomer')}</button>
              )
            )}
            {!split && (
              <button type="button" className="text-brand-700 hover:underline" onClick={() => setSplit({ method: method === 'cash' ? 'debit_card' : 'cash', amount: '' })}>{t('pos.split')}</button>
            )}
            <label className="ml-auto flex items-center gap-1.5 text-slate-600">
              <input type="checkbox" checked={autoPrint} onChange={(e) => toggleAutoPrint(e.target.checked)} data-testid="pos-autoprint" /> {t('ticket.autoPrint')}
            </label>
          </div>
        </div>
      </section>

      {reg.pending.some((p) => p.locationId === locationId) && (
        <section className="card lg:col-span-5">
          <PendingList pending={reg.pending.filter((p) => p.locationId === locationId)} />
        </section>
      )}

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
        <Modal open title={done.sale ? t('pos.doneTitle', { n: done.sale.number }) : t('pos.offline.doneTitle', { n: done.pending?.localNo })} onClose={() => setDone(null)}>
          <div className="space-y-3 text-sm" data-testid="pos-done">
            <p className="text-2xl font-semibold">{money(done.sale?.totalCents ?? done.pending?.totalCents ?? 0)}</p>
            {done.changeCents > 0 && <p className="rounded-lg bg-emerald-50 p-3 text-lg font-semibold text-emerald-800">{t('pos.change', { amount: money(done.changeCents) })}</p>}
            {done.pending && <p className="rounded-lg bg-amber-50 p-3 text-amber-900" data-testid="pos-done-offline">📶 {t('pos.offline.savedHere')}</p>}
            {done.sale && <SaleActions sale={done.sale} startInvoicing={done.invoice} />}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() =>
                  done.sale
                    ? openTicket(done.sale.id, { print: true, changeCents: done.changeCents })
                    : done.pending && openTicket(done.pending.clientId, { print: true, changeCents: done.changeCents, local: true })
                }
                data-testid="pos-print"
              >
                🖨️ {t('ticket.print')}
              </button>
              <button type="button" className="btn-primary" onClick={() => setDone(null)}>{t('pos.newSale')}</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Connection state of the counter: offline selling, sales waiting, ones the server refused. */
function OfflineBar({ online, register, pending, tenantId }: { online: boolean; register: boolean; pending: PendingSale[]; tenantId: string | undefined }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const waiting = pending.filter((p) => !p.error);
  const failed = pending.filter((p) => p.error);
  if (online && !pending.length) return null;
  const upload = async () => {
    if (!tenantId) return;
    setBusy(true);
    try {
      await flushPending(tenantId);
      void qc.invalidateQueries({ queryKey: ['sales'] });
      void qc.invalidateQueries({ queryKey: ['products'] });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 lg:col-span-5" data-testid="pos-offline-bar">
      {(!online || waiting.length > 0) && (
        <div className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 text-sm ${online ? 'border-sky-200 bg-sky-50 text-sky-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
          <span className="font-semibold">{online ? `☁️ ${t('pos.offline.uploading')}` : `📶 ${register ? t('pos.offline.selling') : t('pos.offline.noInternet')}`}</span>
          {waiting.length > 0 && <span data-testid="pos-pending-count">{t('pos.offline.waiting', { count: waiting.length })}</span>}
          {online && waiting.length > 0 && (
            <button type="button" className="btn-secondary !py-1" disabled={busy} onClick={() => void upload()} data-testid="pos-upload-now">
              {t('pos.offline.uploadNow')}
            </button>
          )}
        </div>
      )}
      {failed.map((p) => (
        <div key={p.clientId} className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          <span>{t('pos.offline.refused', { n: p.localNo, amount: money(p.totalCents), reason: t(`pos.${p.error}`, { defaultValue: p.error ?? '' }) })}</span>
          <button type="button" className="btn-secondary !py-1" onClick={() => tenantId && retryPending(tenantId, p.clientId)}>{t('pos.offline.retry')}</button>
        </div>
      ))}
    </div>
  );
}

/** Sales charged without internet, still on this device. */
function PendingList({ pending }: { pending: PendingSale[] }) {
  const { t } = useTranslation();
  if (!pending.length) return null;
  return (
    <ul className="mb-2 divide-y divide-slate-100 rounded-lg border border-amber-200 bg-amber-50/50 px-3 text-sm" data-testid="pos-pending">
      {pending.map((p) => (
        <li key={p.clientId} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <div className="min-w-0">
            <div className="font-medium">
              {p.localNo} · {money(p.totalCents)} <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-800">{p.error ? t('pos.offline.badgeRefused') : t('pos.offline.badge')}</span>
            </div>
            <div className="truncate text-xs text-slate-500">
              {dateTime(p.soldAt)} · {p.items.map((i) => `${i.qty}× ${i.name}`).join(', ')} · {p.payments.map((x) => t(`methods.${x.method}`)).join(' + ')}
            </div>
          </div>
          <button type="button" className="text-brand-700 hover:underline" onClick={() => openTicket(p.clientId, { local: true })}>{t('ticket.ticket')}</button>
        </li>
      ))}
    </ul>
  );
}


/** Invoice and (for managers) cancel buttons of a sale. */
export function SaleActions({ sale, startInvoicing }: { sale: SaleDto; startInvoicing?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { manager } = useAccess();
  const inv = useInvoicing(manager);
  const [invoicing, setInvoicing] = useState(Boolean(startInvoicing));
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['sales'] });
    void qc.invalidateQueries({ queryKey: ['products'] });
    void qc.invalidateQueries({ queryKey: ['payments'] });
  };
  const cancel = useMutation({ mutationFn: () => api(`/sales/${sale.id}/cancel`, { method: 'POST', body: {} }), onSuccess: refresh });
  const canInvoice = manager && inv.data?.available && inv.data.connected && sale.status === 'paid' && !sale.invoice && sale.payments[0];
  return (
    <span className="inline-flex flex-wrap items-center gap-3">
      <button type="button" className="text-brand-700 hover:underline" onClick={() => openTicket(sale.id)} data-testid="sale-ticket">{t('ticket.ticket')}</button>
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


// ---------- Catalog and stock ----------

const emptyProduct = (): ProductInput => ({ name: '', sku: null, category: null, priceCents: 0, costCents: null, trackStock: true, minStock: null, iva: '16', satKey: null, requiresPrescription: false, active: true });

/** Products with their stock at the chosen location: create, edit (double click in the table), receive, count, history, Excel. */
export function ProductsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { businessManager, manager } = useAccess();
  const health = useHealth();
  const enabled = useFeature('cash');
  const { locationId, locationName } = useLocationChoice();
  const products = useProducts(locationId, true, enabled);
  const [edit, setEdit] = useState<{ id: string | null; v: ProductInput } | null>(null);
  const [stock, setStock] = useState<{ p: ProductDto; mode: 'in' | 'set' } | null>(null);
  const [moves, setMoves] = useState<ProductDto | null>(null);
  const [importing, setImporting] = useState(false);
  const [f, setF] = useState({ q: '', category: '', stock: '', status: 'active' });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const refresh = () => void qc.invalidateQueries({ queryKey: ['products'] });
  const remove = useMutation({ mutationFn: (id: string) => api(`/products/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  const all = products.data ?? [];
  const categories = useCategoryList(products.data);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const saveField = async (p: ProductDto, patch: Partial<ProductInput>) => {
    await api(`/products/${p.id}`, { method: 'PUT', body: { ...productInputOf(p), ...patch } });
    refresh();
  };
  const saveStock = async (p: ProductDto, qty: number) => {
    await api(`/products/${p.id}/stock`, { method: 'POST', body: { locationId, mode: 'set', qty, note: null } });
    refresh();
  };
  const text = (max: number) => (s: string) => (s.trim().length <= max ? s.trim() || null : null);
  const pesos = (s: string) => {
    const n = Number(s.replace(/[$,\s]/g, ''));
    return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? toCents(String(n)) : null;
  };
  const whole = (s: string) => {
    const n = Number(s.trim());
    return Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : null;
  };
  const NONE = <span className="text-slate-300">—</span>;
  const yesNo = (p: ProductDto, k: 'trackStock' | 'active' | 'requiresPrescription', label: string) => (
    <Switch checked={p[k]} disabled={!businessManager} onChange={(on) => void saveField(p, { [k]: on })} label={`${label}: ${p.name}`} hideLabel testId={`product-${k}`} />
  );
  const R = 'text-right';
  const { cols, menu } = useColumns<ProductDto>('products', [
    { key: 'number', label: 'ID', className: 'text-slate-500 tabular-nums', td: (p) => (p.number != null ? `#${p.number}` : '') },
    {
      key: 'name', label: t('pos.product'), required: true,
      td: (p) => <EditableCell value={p.name} display={<span className="font-medium">{p.name}</span>} parse={(s) => (s.trim() ? s.trim().slice(0, 120) : null)} onSave={async (name) => { if (name != null) await saveField(p, { name }); }} canEdit={businessManager} testId="product-name" />,
    },
    {
      key: 'category', label: t('pos.category'),
      td: (p) => <EditableCell value={p.category ?? ''} display={p.category ?? NONE} parse={text(60)} allowEmpty onSave={(category) => saveField(p, { category })} canEdit={businessManager} testId="product-category" />,
    },
    {
      key: 'sku', label: t('pos.sku'),
      td: (p) => <EditableCell value={p.sku ?? ''} display={p.sku ?? NONE} parse={text(60)} allowEmpty onSave={(sku) => saveField(p, { sku })} canEdit={businessManager} testId="product-sku" />,
    },
    {
      key: 'price', label: t('pos.price'), className: R,
      td: (p) => <EditableCell value={String(p.priceCents / 100)} display={money(p.priceCents)} parse={pesos} onSave={async (priceCents) => { if (priceCents != null) await saveField(p, { priceCents }); }} canEdit={businessManager} inputMode="decimal" className="!w-24 text-right" testId="product-price" />,
    },
    {
      key: 'cost', label: t('pos.cost'), className: R,
      td: (p) => <EditableCell value={p.costCents == null ? '' : String(p.costCents / 100)} display={p.costCents == null ? NONE : money(p.costCents)} parse={pesos} allowEmpty onSave={(costCents) => saveField(p, { costCents })} canEdit={businessManager} inputMode="decimal" className="!w-24 text-right" testId="product-cost" />,
    },
    {
      key: 'stock', label: t('pos.stock'), className: R,
      td: (p) =>
        p.trackStock ? (
          <span className={`font-semibold ${p.low ? 'text-amber-700' : ''}`}>
            <EditableCell value={String(p.stock)} display={p.stock} parse={whole} onSave={async (qty) => { if (qty != null) await saveStock(p, qty); }} canEdit={manager} inputMode="numeric" className="!w-20 text-right" testId="product-stock" />
          </span>
        ) : NONE,
    },
    {
      key: 'minStock', label: t('pos.minStock'), className: R,
      td: (p) => <EditableCell value={p.minStock == null ? '' : String(p.minStock)} display={p.minStock ?? NONE} parse={whole} allowEmpty onSave={(minStock) => saveField(p, { minStock })} canEdit={businessManager} inputMode="numeric" className="!w-20 text-right" testId="product-min" />,
    },
    { key: 'trackStock', label: t('pos.trackStock'), td: (p) => yesNo(p, 'trackStock', t('pos.trackStock')) },
    {
      key: 'iva', label: 'IVA',
      td: (p) => (
        <EditableCell
          value={p.iva}
          display={p.iva === 'exento' ? t('pos.ivaExempt') : `${p.iva}%`}
          parse={(s) => { const v = s.trim().toLowerCase().replace('%', ''); return v === '16' || v === '0' ? v : v.startsWith('exent') ? 'exento' : null; }}
          onSave={async (iva) => { if (iva != null) await saveField(p, { iva: iva as ProductInput['iva'] }); }}
          canEdit={businessManager}
          className="!w-20"
          testId="product-iva"
        />
      ),
    },
    {
      key: 'satKey', label: t('pos.satKey'), className: 'font-mono text-xs',
      td: (p) => <EditableCell value={p.satKey ?? ''} display={p.satKey ?? NONE} parse={(s) => (/^\d{8}$/.test(s.trim()) ? s.trim() : null)} allowEmpty onSave={(satKey) => saveField(p, { satKey })} canEdit={businessManager} inputMode="numeric" className="!w-28" testId="product-sat" />,
    },
    ...(health ? [{ key: 'rx', label: t('pos.rx'), td: (p: ProductDto) => yesNo(p, 'requiresPrescription', t('pos.rx')) }] : []),
    { key: 'active', label: t('pos.active'), td: (p) => yesNo(p, 'active', t('pos.active')) },
    {
      key: 'actions', label: t('columns.actions'), required: true, className: 'text-right',
      td: (p) => (
        <span className="inline-flex flex-wrap justify-end gap-2 text-xs">
          {p.trackStock && <button type="button" className="text-brand-700 hover:underline" onClick={() => setStock({ p, mode: 'in' })} data-testid="stock-in">{t('pos.receive')}</button>}
          {p.trackStock && <button type="button" className="text-brand-700 hover:underline" onClick={() => setStock({ p, mode: 'set' })}>{t('pos.count')}</button>}
          <button type="button" className="text-brand-700 hover:underline" onClick={() => setMoves(p)}>{t('pos.history')}</button>
          {businessManager && <button type="button" className="text-brand-700 hover:underline" onClick={() => setEdit({ id: p.id, v: { ...p } })}>{t('common.edit')}</button>}
          {businessManager && p.active && <button type="button" className="text-rose-700 hover:underline" onClick={() => window.confirm(t('pos.deleteConfirm')) && remove.mutate(p.id)}>{t('common.delete')}</button>}
        </span>
      ),
    },
  ]);
  if (!enabled) return <UpgradeNote feature="cash" />;
  const q = f.q.trim().toLocaleLowerCase('es').replace(/^#/, '');
  const list = all.filter(
    (p) =>
      (!q || String(p.number) === q || [p.name, p.sku, p.category].some((x) => x?.toLocaleLowerCase('es').includes(q))) &&
      (!f.category || (f.category === '-' ? !p.category : p.category === f.category)) &&
      (!f.status || (f.status === 'active' ? p.active : !p.active)) &&
      (!f.stock ||
        (f.stock === 'low' ? p.low : f.stock === 'out' ? p.trackStock && p.stock <= 0 : f.stock === 'in' ? p.trackStock && p.stock > 0 : !p.trackStock)),
  );
  const low = all.filter((p) => p.active && p.low);
  const filtered = Boolean(q || f.category || f.stock || f.status !== 'active');
  return (
    <section className="space-y-3" data-testid="products-tab">
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${FILTER_CTRL} min-w-[12rem] flex-1`} placeholder={t('pos.search')} value={f.q} onChange={(e) => set({ q: e.target.value })} data-testid="products-search" />
        <select className={FILTER_CTRL} aria-label={t('pos.category')} value={f.category} onChange={(e) => set({ category: e.target.value })} data-testid="products-category">
          <option value="">{t('pos.category')}: {t('payments.any')}</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          <option value="-">{t('pos.inventory.noCategory')}</option>
        </select>
        <select className={FILTER_CTRL} aria-label={t('pos.stock')} value={f.stock} onChange={(e) => set({ stock: e.target.value })} data-testid="products-stock">
          <option value="">{t('pos.stock')}: {t('payments.any')}</option>
          <option value="in">{t('pos.inventory.inStock')}</option>
          <option value="low">{t('pos.inventory.lowOnly')}</option>
          <option value="out">{t('pos.inventory.outOfStock')}</option>
          <option value="untracked">{t('pos.inventory.untracked')}</option>
        </select>
        <select className={FILTER_CTRL} aria-label={t('pos.active')} value={f.status} onChange={(e) => set({ status: e.target.value })} data-testid="products-status">
          <option value="active">{t('pos.inventory.activeOnly')}</option>
          <option value="inactive">{t('pos.inventory.inactiveOnly')}</option>
          <option value="">{t('pos.inventory.allStatus')}</option>
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {menu}
        <button type="button" className={TOOLBAR_BTN} disabled={!list.length} onClick={() => void downloadInventory(list, { health, locationName, categories })} data-testid="products-export">
          ⬇ {filtered ? t('pos.inventory.exportFiltered', { count: list.length }) : t('pos.inventory.export')}
        </button>
        {businessManager && (
          <>
            <button type="button" className={TOOLBAR_BTN} onClick={() => setImporting(true)} data-testid="products-import">⬆ {t('pos.inventory.import')}</button>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <button type="button" className={TOOLBAR_BTN} onClick={() => setSettingsOpen(true)} data-testid="pos-settings-open">⚙ {t('pos.settings.button')}</button>
              <button type="button" className="btn-primary !h-9 !py-0" onClick={() => setEdit({ id: null, v: emptyProduct() })} data-testid="new-product">{t('pos.newProduct')}</button>
            </span>
          </>
        )}
      </div>
      {low.length > 0 && <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900" data-testid="low-stock">⚠️ {t('pos.lowStock', { names: low.map((p) => p.name).join(', ') })}</p>}
      {(businessManager || manager) && list.length > 0 && <p className="text-xs text-slate-500">{t('pos.inventory.dblClickHint')}</p>}
      {products.isLoading ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty>{all.length ? t('payments.noMatch') : t('pos.noProducts')}</Empty>
      ) : (
        <DataTable cols={cols} rows={list} rowKey={(p) => p.id} rowClassName={(p) => (p.active ? '' : 'opacity-50')} rowTestId="product-row" />
      )}
      <ErrorText error={remove.error} />
      {edit && (
        <ProductModal
          value={edit.v}
          id={edit.id}
          locationId={locationId}
          categories={categories}
          skus={all.filter((p) => p.id !== edit.id && p.sku).map((p) => p.sku!)}
          onClose={() => setEdit(null)}
          onDone={refresh}
        />
      )}
      {settingsOpen && <PosSettingsModal products={all} onClose={() => setSettingsOpen(false)} />}
      {stock && <StockModal product={stock.p} mode={stock.mode} locationId={locationId} onClose={() => setStock(null)} onDone={refresh} />}
      {moves && <MovesModal product={moves} locationId={locationId} onClose={() => setMoves(null)} />}
      {importing && <ImportModal locationId={locationId} locationName={locationName} onTemplate={() => void downloadInventory(null, { health, categories })} onClose={() => setImporting(false)} onDone={refresh} />}
    </section>
  );
}

/** What PUT /products/:id takes, from what the list shows. */
const productInputOf = (p: ProductDto): ProductInput => ({
  name: p.name, sku: p.sku, category: p.category, priceCents: p.priceCents, costCents: p.costCents, trackStock: p.trackStock,
  minStock: p.minStock, iva: p.iva, satKey: p.satKey, requiresPrescription: p.requiresPrescription, active: p.active,
});

function ProductModal({
  value,
  id,
  locationId,
  categories,
  skus,
  lookup,
  onClose,
  onDone,
}: {
  value: ProductInput;
  id: string | null;
  locationId: string;
  categories: string[];
  /** SKUs already used (suggestions avoid them) */
  skus: string[];
  /** Barcode just scanned: look it up on the internet to fill the name */
  lookup?: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<{ found: boolean; source?: string } | null>(null);
  const findOnline = useMutation({
    mutationFn: (code: string) => api<{ found: boolean; name?: string; source?: string }>(`/products/lookup?code=${encodeURIComponent(code)}`),
    onSuccess: (r) => {
      setFound(r);
      if (r.found && r.name) setV((x) => ({ ...x, name: x.name.trim() ? x.name : r.name! }));
    },
  });
  useEffect(() => {
    if (lookup && /^\d{8,14}$/.test(lookup)) findOnline.mutate(lookup);
  }, [lookup]); // eslint-disable-line react-hooks/exhaustive-deps
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
        <div className="block text-sm"><span className="label">{t('pos.category')}</span><CategoryField value={v.category ?? null} options={categories} onChange={(category) => set({ category })} /></div>
        <div className="block text-sm">
          <span className="label">{t('pos.fields.skuLabel')}</span>
          <div className="flex gap-1">
            <input className="input font-mono" maxLength={60} value={v.sku ?? ''} onChange={(e) => set({ sku: e.target.value })} data-testid="pf-sku" />
            {cameraScanAvailable() && (
              <button type="button" className="btn-secondary !px-2" title={t('pos.scan.button')} aria-label={t('pos.scan.button')} onClick={() => setScanning(true)}>📷</button>
            )}
          </div>
          {!id && v.sku && /^\d{8,14}$/.test(v.sku) && (
            <button type="button" className="mt-1 mr-3 text-xs text-brand-700 hover:underline disabled:opacity-50" disabled={findOnline.isPending} onClick={() => findOnline.mutate(v.sku!)} data-testid="pf-lookup">
              {findOnline.isPending ? t('pos.scan.looking') : `🔎 ${t('pos.scan.lookup')}`}
            </button>
          )}
          {found && (
            <p className={`mt-1 text-xs ${found.found ? 'text-emerald-700' : 'text-slate-500'}`} data-testid="pf-lookup-result">
              {found.found ? t('pos.scan.foundAt', { source: found.source }) : t('pos.scan.notOnline')}
            </p>
          )}
          {!v.sku && v.name.trim() && (
            <button type="button" className="mt-1 text-xs text-brand-700 hover:underline" onClick={() => set({ sku: suggestSku(v.name, skus) })} data-testid="pf-sku-suggest">
              {t('pos.fields.suggestSku', { sku: suggestSku(v.name, skus) })}
            </button>
          )}
        </div>
        <div className="sm:col-span-2"><Switch checked={v.trackStock !== false} onChange={(trackStock) => set({ trackStock })} label={t('pos.trackStock')} testId="product-track" /></div>
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
        <div className="block text-sm"><span className="label">{t('pos.satKey')}</span><SatKeyField value={v.satKey ?? null} onChange={(satKey) => set({ satKey })} productName={v.name} /></div>
        {health && (
          <div className="sm:col-span-2"><Switch checked={Boolean(v.requiresPrescription)} onChange={(requiresPrescription) => set({ requiresPrescription })} label={t('pos.requiresRx')} /></div>
        )}
        {id && <div className="sm:col-span-2"><Switch checked={v.active !== false} onChange={(active) => set({ active })} label={t('pos.active')} /></div>}
        {scanning && <CameraScanModal onCode={(sku) => { set({ sku }); setScanning(false); }} onClose={() => setScanning(false)} />}
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
