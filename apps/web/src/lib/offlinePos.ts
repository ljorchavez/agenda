/**
 * Point of sale without internet. A computer the owner marks as a "register" keeps a copy of
 * the catalog and the ticket header, and keeps selling when the connection drops: sales wait
 * here (localStorage, shared by the app's tabs and the ticket window) and are uploaded on their
 * own when it comes back. Each sale carries a clientId so a retry never saves it twice.
 */
import type { AuthResponse, BusinessSummary, PosHeaderDto, PosMethod, ProductDto, SaleCreateInput, SessionUser, TenantDto } from '@agenda/shared';
import { api, ApiError } from './api';

/** A register that hasn't reached the server for this long stops selling offline. */
export const OFFLINE_MAX_MS = 72 * 3600_000;

export interface PendingSale {
  clientId: string;
  /** Number on the provisional ticket, per device: P-0007 */
  localNo: string;
  locationId: string;
  soldAt: string;
  body: SaleCreateInput;
  /** For the list and the local ticket */
  items: { name: string; qty: number; unitCents: number; totalCents: number }[];
  payments: { method: PosMethod; amountCents: number }[];
  totalCents: number;
  customerName: string | null;
  createdByName: string | null;
  /** The server refused it (it needs a person to look at it) */
  error: string | null;
}

export interface OpenTicket {
  id: string;
  lines: { key: string; productId: string | null; name: string; qty: number; unitCents: number; rx?: boolean; max?: number | null }[];
  customerId: string;
  customerName: string | null;
  createdAt: string;
}

const get = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const put = (key: string, value: unknown) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked: the sale still goes online */
  }
};

const k = {
  register: (t: string) => `lugali.pos.register.${t}`,
  catalog: (t: string, l: string) => `lugali.pos.catalog.${t}.${l}`,
  header: (t: string, l: string) => `lugali.pos.header.${t}.${l}`,
  queue: (t: string) => `lugali.pos.queue.${t}`,
  sent: (t: string) => `lugali.pos.sent.${t}`,
  seq: (t: string) => `lugali.pos.seq.${t}`,
  online: (t: string) => `lugali.pos.lastOnline.${t}`,
  location: (t: string) => `lugali.pos.location.${t}`,
  tickets: (t: string, l: string) => `lugali.pos.tickets.${t}.${l}`,
  me: 'lugali.pos.me',
  lock: (t: string) => `lugali.pos.lock.${t}`,
};

/** fetch() itself failed: no internet (not an answer from the server). */
export const isNetworkError = (e: unknown) => e instanceof TypeError || (e instanceof Error && e.name === 'NetworkError');

export const uuid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));

// ---------- This computer as a register ----------

/** Every computer sells offline unless it was turned off on purpose. */
export const isRegister = (tenantId: string | undefined) => Boolean(tenantId && get<{ on: boolean } | null>(k.register(tenantId), null)?.on !== false);
export function setRegister(tenantId: string, on: boolean) {
  put(k.register(tenantId), on ? { on: true, since: new Date().toISOString() } : { on: false });
  if (!on) forgetCopies(tenantId);
  notify();
}

/** Copies of business data on this device (pending sales stay: they are money already taken). */
export function forgetCopies(tenantId: string) {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(`lugali.pos.catalog.${tenantId}.`) || key.startsWith(`lugali.pos.header.${tenantId}.`)) localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
  const me = get<{ tenant: { id: string } } | null>(k.me, null);
  if (me?.tenant.id === tenantId) put(k.me, null);
}

export const markOnline = (tenantId: string) => put(k.online(tenantId), Date.now());
export const lastOnline = (tenantId: string) => get<number>(k.online(tenantId), 0);
export const offlineExpired = (tenantId: string) => Date.now() - lastOnline(tenantId) > OFFLINE_MAX_MS;

/** Session to open the app without internet (only registers keep it). */
export function saveSession(me: { user: SessionUser; tenant: TenantDto; businesses: BusinessSummary[] }) {
  if (isRegister(me.tenant.id)) put(k.me, { ...me, savedAt: Date.now() });
}
export function loadSession(): (Pick<AuthResponse, 'user' | 'tenant'> & { businesses: BusinessSummary[] }) | null {
  const me = get<{ user: SessionUser; tenant: TenantDto; businesses: BusinessSummary[]; savedAt: number } | null>(k.me, null);
  if (!me || !isRegister(me.tenant.id) || offlineExpired(me.tenant.id)) return null;
  return me;
}

export const saveCatalog = (tenantId: string, locationId: string, products: ProductDto[]) => put(k.catalog(tenantId, locationId), products);
export const loadCatalog = (tenantId: string, locationId: string) => get<ProductDto[] | null>(k.catalog(tenantId, locationId), null);
export const saveHeader = (tenantId: string, locationId: string, h: PosHeaderDto) => put(k.header(tenantId, locationId), h);
export const loadHeader = (tenantId: string, locationId: string) => get<PosHeaderDto | null>(k.header(tenantId, locationId), null);
export const saveLocation = (tenantId: string, locationId: string) => put(k.location(tenantId), locationId);
export const loadLocation = (tenantId: string) => get<string>(k.location(tenantId), '');

/** Keeps the register's copy of stock roughly right after an offline sale. */
export function takeFromCatalog(tenantId: string, locationId: string, lines: { productId: string | null; qty: number }[]) {
  const list = loadCatalog(tenantId, locationId);
  if (!list) return;
  saveCatalog(
    tenantId,
    locationId,
    list.map((p) => {
      const sold = lines.filter((l) => l.productId === p.id).reduce((a, l) => a + l.qty, 0);
      return sold && p.trackStock ? { ...p, stock: p.stock - sold, low: p.minStock != null && p.stock - sold <= p.minStock } : p;
    }),
  );
}

// ---------- Open tickets (several customers at once) ----------

export const loadTickets = (tenantId: string, locationId: string) => get<OpenTicket[]>(k.tickets(tenantId, locationId), []);
export const saveTickets = (tenantId: string, locationId: string, list: OpenTicket[]) =>
  put(k.tickets(tenantId, locationId), list.length ? list : null);

// ---------- Sales waiting to be uploaded ----------

export const pendingSales = (tenantId: string) => get<PendingSale[]>(k.queue(tenantId), []);
const setPending = (tenantId: string, list: PendingSale[]) => {
  put(k.queue(tenantId), list.length ? list : null);
  notify();
};
export function addPending(tenantId: string, s: Omit<PendingSale, 'localNo' | 'error'>): PendingSale {
  const n = get<number>(k.seq(tenantId), 0) + 1;
  put(k.seq(tenantId), n);
  const full: PendingSale = { ...s, localNo: `P-${String(n).padStart(4, '0')}`, error: null };
  setPending(tenantId, [...pendingSales(tenantId).filter((p) => p.clientId !== s.clientId), full]);
  return full;
}
export const dropPending = (tenantId: string, clientId: string) => setPending(tenantId, pendingSales(tenantId).filter((p) => p.clientId !== clientId));
/** The sale went through right away: drop it and give back its provisional number if it was the last one. */
export function releasePending(tenantId: string, clientId: string) {
  const p = findPending(tenantId, clientId);
  const n = get<number>(k.seq(tenantId), 0);
  if (p && p.localNo === `P-${String(n).padStart(4, '0')}`) put(k.seq(tenantId), n - 1 || null);
  dropPending(tenantId, clientId);
}
export const findPending = (tenantId: string, clientId: string) => pendingSales(tenantId).find((p) => p.clientId === clientId) ?? null;

/** Where an uploaded sale went: its local ticket then opens the real one. */
export function recordSent(tenantId: string, clientId: string, saleId: string) {
  const list = get<[string, string][]>(k.sent(tenantId), []).filter(([c]) => c !== clientId);
  put(k.sent(tenantId), [...list, [clientId, saleId]].slice(-100));
}
export const sentSaleId = (tenantId: string, clientId: string) => get<[string, string][]>(k.sent(tenantId), []).find(([c]) => c === clientId)?.[1] ?? null;

/** Finds which business a pending sale belongs to (the ticket window only has its id). */
export function findPendingAnywhere(clientId: string): { tenantId: string; sale: PendingSale | null; saleId: string | null } | null {
  try {
    for (const key of Object.keys(localStorage)) {
      const m = /^lugali\.pos\.(queue|sent)\.(.+)$/.exec(key);
      if (!m) continue;
      const tenantId = m[2]!;
      const sale = findPending(tenantId, clientId);
      const saleId = sentSaleId(tenantId, clientId);
      if (sale || saleId) return { tenantId, sale, saleId };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Uploads what's waiting, oldest first. Stops at the first network failure; a sale the server
 * refuses keeps its error for someone to look at. One tab at a time (a short lock).
 */
let flushing = false;
export async function flushPending(tenantId: string): Promise<{ sent: number; failed: number }> {
  const out = { sent: 0, failed: 0 };
  if (flushing || (typeof navigator !== 'undefined' && navigator.onLine === false)) return out;
  const lock = get<number>(k.lock(tenantId), 0);
  if (Date.now() - lock < 30_000) return out;
  flushing = true;
  put(k.lock(tenantId), Date.now());
  try {
    for (const p of pendingSales(tenantId)) {
      if (p.error) continue;
      try {
        const sale = await api<{ id: string }>('/sales', { method: 'POST', body: { ...p.body, clientId: p.clientId, offline: true, soldAt: p.soldAt } });
        recordSent(tenantId, p.clientId, sale.id);
        dropPending(tenantId, p.clientId);
        markOnline(tenantId);
        out.sent++;
      } catch (e) {
        if (isNetworkError(e)) break;
        // The register is in read-only (unpaid plan) or the session ended: try again later
        if (e instanceof ApiError && (e.status === 401 || e.status === 402 || e.status >= 500)) break;
        setPending(tenantId, pendingSales(tenantId).map((x) => (x.clientId === p.clientId ? { ...x, error: e instanceof ApiError ? e.code : 'error' } : x)));
        out.failed++;
      }
    }
  } finally {
    flushing = false;
    put(k.lock(tenantId), null);
  }
  return out;
}
export const retryPending = (tenantId: string, clientId: string) =>
  setPending(tenantId, pendingSales(tenantId).map((x) => (x.clientId === clientId ? { ...x, error: null } : x)));

// ---------- Change notifications (this tab and others) ----------

const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith('lugali.pos.')) fn();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}
