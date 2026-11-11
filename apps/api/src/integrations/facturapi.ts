/**
 * Facturapi (CFDI 4.0) client: https://www.facturapi.io/v2
 * - FACTURAPI_USER_KEY: the platform's account key; creates one organization (issuer) per business.
 * - Each organization has its own test and live keys; we keep them encrypted with the business.
 * Without FACTURAPI_USER_KEY the feature is hidden. Tests swap the transport (setFacturapiFetch).
 */
import { AppError } from '../lib/errors.js';

const BASE = 'https://www.facturapi.io/v2';
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
let transport: Fetch = (url, init) => fetch(url, init);
/** Tests only. */
export function setFacturapiFetch(fn: Fetch | null) {
  transport = fn ?? ((url, init) => fetch(url, init));
}

export const facturapiAvailable = () => Boolean(process.env.FACTURAPI_USER_KEY?.trim());

async function call<T>(key: string, method: string, path: string, body?: unknown, raw = false): Promise<T> {
  const init: RequestInit = { method, headers: { Authorization: `Bearer ${key}` } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  let res: Response;
  try {
    res = await transport(`${BASE}${path}`, init);
  } catch {
    throw new AppError(502, 'facturapi_unreachable', 'Could not reach the invoicing service');
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { message?: string };
    // Facturapi explains SAT problems in Spanish; pass them on to the business
    throw new AppError(422, 'facturapi_error', j.message ?? `Invoicing error (${res.status})`, { message: j.message ?? null });
  }
  if (raw) return res as unknown as T;
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

const userKey = () => {
  const k = process.env.FACTURAPI_USER_KEY?.trim();
  if (!k) throw new AppError(422, 'invoicing_unavailable', 'Electronic invoicing is not available yet');
  return k;
};

export async function createOrganization(name: string): Promise<{ id: string }> {
  return call(userKey(), 'POST', '/organizations', { name });
}
export async function updateLegal(orgId: string, data: { name: string; legal_name: string; tax_system: string; address: { zip: string } }) {
  return call(userKey(), 'PUT', `/organizations/${encodeURIComponent(orgId)}/legal`, data);
}
export async function uploadCertificate(orgId: string, cer: Blob, key: Blob, password: string) {
  const fd = new FormData();
  fd.append('cer', cer, 'cer.cer');
  fd.append('key', key, 'key.key');
  fd.append('password', password);
  return call<{ certificate?: { expires_at?: string } }>(userKey(), 'PUT', `/organizations/${encodeURIComponent(orgId)}/certificate`, fd);
}
export async function testKey(orgId: string): Promise<string> {
  return call<string>(userKey(), 'GET', `/organizations/${encodeURIComponent(orgId)}/apikeys/test`);
}
export async function renewLiveKey(orgId: string): Promise<string> {
  return call<string>(userKey(), 'PUT', `/organizations/${encodeURIComponent(orgId)}/apikeys/live`);
}

export interface FacturapiInvoice {
  id: string;
  uuid?: string | null;
  series?: string | null;
  folio_number?: number | null;
  total: number;
  status: string;
  livemode?: boolean;
}
export interface InvoiceInput {
  customer: { legal_name: string; tax_id: string; tax_system: string; email?: string; address: { zip: string } };
  items: { quantity: number; product: { description: string; product_key: string; price: number; tax_included: boolean; taxes: { type: 'IVA'; rate?: number; factor?: 'Exento' | 'Tasa' }[] } }[];
  payment_form: string;
  payment_method: 'PUE';
  use: string;
  series?: string;
}
export const createInvoice = (key: string, input: InvoiceInput) => call<FacturapiInvoice>(key, 'POST', '/invoices', input);
export const invoiceFile = (key: string, id: string, kind: 'pdf' | 'xml') => call<Response>(key, 'GET', `/invoices/${encodeURIComponent(id)}/${kind}`, undefined, true);
export const emailInvoice = (key: string, id: string, email?: string) => call(key, 'POST', `/invoices/${encodeURIComponent(id)}/email`, email ? { email } : {});
export const cancelInvoice = (key: string, id: string, motive: string) =>
  call<FacturapiInvoice>(key, 'DELETE', `/invoices/${encodeURIComponent(id)}?motive=${encodeURIComponent(motive)}`);
