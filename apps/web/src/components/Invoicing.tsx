import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CFDI_USES,
  IVA_OPTIONS,
  TAX_SYSTEMS,
  type CustomerFiscal,
  type CustomerWithStats,
  type InvoiceDto,
  type InvoicingSettings,
  type InvoicingStatusDto,
  type PaymentDto,
} from '@agenda/shared';
import { api } from '../lib/api';
import { money } from '../lib/format';
import { ErrorText, Modal } from './ui';

export const useInvoicing = (enabled = true) =>
  useQuery({ queryKey: ['invoicing'], queryFn: () => api<InvoicingStatusDto>('/invoicing'), enabled, retry: false, staleTime: 60_000 });

/** Configuración → Facturación: the business's fiscal data and its CSD. */
export function InvoicingSection({ canEdit }: { canEdit: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useInvoicing();
  const d = q.data;
  const [form, setForm] = useState<InvoicingSettings | null>(null);
  const v: InvoicingSettings | null = form ?? d?.settings ?? (d ? { rfc: '', legalName: '', taxSystem: '612', zip: '', series: 'F', productKey: d.defaults.productKey, description: d.defaults.description, iva: d.defaults.iva, autoEmail: true } : null);
  const save = useMutation({
    mutationFn: () => api<InvoicingStatusDto>('/invoicing', { method: 'PUT', body: v }),
    onSuccess: (r) => {
      qc.setQueryData(['invoicing'], r);
      setForm(null);
    },
  });
  const [cer, setCer] = useState<File | null>(null);
  const [key, setKey] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const upload = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append('cer', cer!);
      fd.append('key', key!);
      fd.append('password', password);
      return api<InvoicingStatusDto>('/invoicing/certificate', { method: 'PUT', body: fd });
    },
    onSuccess: (r) => {
      qc.setQueryData(['invoicing'], r);
      setPassword('');
    },
  });
  if (!d || !v) return <section className="card"><ErrorText error={q.error} /></section>;
  const set = (p: Partial<InvoicingSettings>) => setForm({ ...v, ...p });
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2" data-testid="invoicing-section">
      <section className="card space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">🧾 {t('invoicing.title')}</h2>
          {d.connected && (
            <span className={`rounded-full px-2 py-0.5 text-xs ${d.live ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`} data-testid="invoicing-mode">
              {d.live ? t('invoicing.live') : t('invoicing.test')}
            </span>
          )}
        </div>
        {!d.available && <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600" data-testid="invoicing-unavailable">{t('invoicing.unavailable')}</p>}
        <p className="text-xs text-slate-500">{t('invoicing.help')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="label">RFC</span>
            <input className="input font-mono uppercase" disabled={!canEdit} value={v.rfc} maxLength={13} onChange={(e) => set({ rfc: e.target.value.toUpperCase() })} />
          </label>
          <label className="block text-sm">
            <span className="label">{t('invoicing.zip')}</span>
            <input className="input" inputMode="numeric" maxLength={5} disabled={!canEdit} value={v.zip} onChange={(e) => set({ zip: e.target.value.replace(/\D/g, '') })} />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="label">{t('invoicing.legalName')}</span>
            <input className="input uppercase" disabled={!canEdit} value={v.legalName} onChange={(e) => set({ legalName: e.target.value.toUpperCase() })} placeholder={t('invoicing.legalNameHelp')} />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="label">{t('invoicing.taxSystem')}</span>
            <select className="input" disabled={!canEdit} value={v.taxSystem} onChange={(e) => set({ taxSystem: e.target.value })}>
              {TAX_SYSTEMS.map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="label">{t('invoicing.productKey')}</span>
            <input className="input font-mono" inputMode="numeric" maxLength={8} disabled={!canEdit} value={v.productKey} onChange={(e) => set({ productKey: e.target.value.replace(/\D/g, '') })} />
          </label>
          <label className="block text-sm">
            <span className="label">IVA</span>
            <select className="input" disabled={!canEdit} value={v.iva} onChange={(e) => set({ iva: e.target.value as InvoicingSettings['iva'] })}>
              {IVA_OPTIONS.map((x) => <option key={x} value={x}>{t(`invoicing.iva.${x}`)}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="label">{t('invoicing.description')}</span>
            <input className="input" disabled={!canEdit} value={v.description} onChange={(e) => set({ description: e.target.value })} />
          </label>
          <label className="block text-sm">
            <span className="label">{t('invoicing.series')}</span>
            <input className="input uppercase" maxLength={10} disabled={!canEdit} value={v.series ?? ''} onChange={(e) => set({ series: e.target.value.toUpperCase() || null })} />
          </label>
        </div>
        <p className="text-xs text-slate-500">{t('invoicing.keyHelp')}</p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" disabled={!canEdit} checked={v.autoEmail !== false} onChange={(e) => set({ autoEmail: e.target.checked })} />
          {t('invoicing.autoEmail')}
        </label>
        <ErrorText error={save.error} ns="invoicing" />
        {canEdit && (
          <button type="button" className="btn-primary" disabled={save.isPending || !form} onClick={() => save.mutate()} data-testid="invoicing-save">
            {d.connected || !d.available ? t('invoicing.saveData') : t('invoicing.connect')}
          </button>
        )}
      </section>
      {d.connected && (
        <section className="card space-y-3" data-testid="invoicing-csd">
          <h2 className="font-semibold">🔐 {t('invoicing.csd')}</h2>
          <p className="text-xs text-slate-500">{d.live ? t('invoicing.csdDone') : t('invoicing.csdHelp')}</p>
          {canEdit && (
            <>
              <label className="block text-sm"><span className="label">{t('invoicing.cer')}</span><input type="file" accept=".cer" className="text-sm" onChange={(e) => setCer(e.target.files?.[0] ?? null)} /></label>
              <label className="block text-sm"><span className="label">{t('invoicing.key')}</span><input type="file" accept=".key" className="text-sm" onChange={(e) => setKey(e.target.files?.[0] ?? null)} /></label>
              <label className="block text-sm"><span className="label">{t('invoicing.password')}</span><input type="password" className="input" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
              <ErrorText error={upload.error} ns="invoicing" />
              <button type="button" className="btn-primary" disabled={!cer || !key || !password || upload.isPending} onClick={() => upload.mutate()}>{t('invoicing.upload')}</button>
            </>
          )}
        </section>
      )}
    </div>
  );
}

async function download(path: string, name: string) {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin' });
  if (!res.ok) return;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** "Factura" cell of a payment: issue it, or download / send / cancel the one it has. */
export function InvoiceCell({ payment }: { payment: PaymentDto }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const inv = payment.invoice;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['payments'] });
  const send = useMutation({ mutationFn: () => api(`/invoices/${inv!.id}/email`, { method: 'POST', body: {} }) });
  const cancel = useMutation({
    mutationFn: (motive: '02' | '03') => api(`/invoices/${inv!.id}/cancel`, { method: 'POST', body: { motive } }),
    onSuccess: refresh,
  });
  if (inv) {
    const label = `${inv.series ?? ''}${inv.folio ?? ''}` || t('invoicing.invoice');
    return (
      <span className="relative">
        <button type="button" className="text-brand-700 hover:underline" onClick={() => setMenu(!menu)} data-testid="invoice-menu">
          🧾 {label}{inv.test ? ` (${t('invoicing.testShort')})` : ''}{inv.status === 'pending' ? ` · ${t('invoicing.cancelPending')}` : ''}
        </button>
        {menu && (
          <span className="absolute right-0 z-20 mt-1 flex w-48 flex-col rounded-lg border border-slate-200 bg-white py-1 text-left text-sm shadow-lg">
            <button type="button" className="px-3 py-1.5 text-left hover:bg-slate-50" onClick={() => void download(`/invoices/${inv.id}/pdf`, `${label}.pdf`)}>PDF</button>
            <button type="button" className="px-3 py-1.5 text-left hover:bg-slate-50" onClick={() => void download(`/invoices/${inv.id}/xml`, `${label}.xml`)}>XML</button>
            <button type="button" className="px-3 py-1.5 text-left hover:bg-slate-50" onClick={() => send.mutate()}>{send.isSuccess ? t('invoicing.sent') : t('invoicing.email')}</button>
            {inv.status === 'valid' && (
              <button type="button" className="px-3 py-1.5 text-left text-rose-700 hover:bg-rose-50" onClick={() => window.confirm(t('invoicing.cancelConfirm')) && cancel.mutate('02')}>{t('invoicing.cancel')}</button>
            )}
            <ErrorText error={send.error ?? cancel.error} ns="invoicing" />
          </span>
        )}
      </span>
    );
  }
  if (payment.status !== 'paid') return null;
  return (
    <>
      <button type="button" className="text-brand-700 hover:underline" onClick={() => setOpen(true)} data-testid="invoice-button">{t('invoicing.issue')}</button>
      {open && <InvoiceModal payment={payment} onClose={() => setOpen(false)} onDone={refresh} />}
    </>
  );
}

/** Issues the CFDI of a payment (for a counter sale, of the whole sale: pass its total). */
export function InvoiceModal({ payment, onClose, onDone, amountCents }: { payment: Pick<PaymentDto, 'id' | 'customerId' | 'amountCents'>; onClose: () => void; onDone: () => void; amountCents?: number }) {
  const { t } = useTranslation();
  const status = useInvoicing();
  const cu = useQuery({ queryKey: ['customer', payment.customerId], queryFn: () => api<CustomerWithStats>(`/customers/${payment.customerId}`) });
  const [pub, setPub] = useState<boolean | null>(null);
  const [f, setF] = useState<CustomerFiscal | null>(null);
  const [save, setSave] = useState(true);
  const fiscal: CustomerFiscal = f ?? cu.data?.fiscal ?? { rfc: '', legalName: '', taxSystem: '612', zip: '', use: status.data?.defaults.use ?? 'G03', email: cu.data?.email ?? null };
  const isPublic = pub ?? !cu.data?.fiscal;
  const set = (p: Partial<CustomerFiscal>) => setF({ ...fiscal, ...p });
  const issue = useMutation({
    mutationFn: () => api<InvoiceDto>(`/payments/${payment.id}/invoice`, { method: 'POST', body: { customer: isPublic ? null : { ...fiscal, email: fiscal.email || null }, save } }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  return (
    <Modal open title={t('invoicing.issueTitle', { amount: money(amountCents ?? payment.amountCents) })} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); issue.mutate(); }} data-testid="invoice-modal">
        {!status.data?.live && <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">{t('invoicing.testNotice')}</p>}
        <div className="flex gap-2 text-sm">
          <button type="button" className={isPublic ? 'btn-primary !py-1.5' : 'btn-secondary !py-1.5'} onClick={() => setPub(true)}>{t('invoicing.public')}</button>
          <button type="button" className={!isPublic ? 'btn-primary !py-1.5' : 'btn-secondary !py-1.5'} onClick={() => setPub(false)}>{t('invoicing.withRfc')}</button>
        </div>
        {!isPublic && (
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-sm"><span className="label">RFC</span><input required className="input font-mono uppercase" maxLength={13} value={fiscal.rfc} onChange={(e) => set({ rfc: e.target.value.toUpperCase() })} /></label>
            <label className="block text-sm"><span className="label">{t('invoicing.zip')}</span><input required className="input" inputMode="numeric" maxLength={5} value={fiscal.zip} onChange={(e) => set({ zip: e.target.value.replace(/\D/g, '') })} /></label>
            <label className="block text-sm sm:col-span-2"><span className="label">{t('invoicing.legalName')}</span><input required className="input uppercase" value={fiscal.legalName} onChange={(e) => set({ legalName: e.target.value.toUpperCase() })} /></label>
            <label className="block text-sm sm:col-span-2">
              <span className="label">{t('invoicing.taxSystem')}</span>
              <select className="input" value={fiscal.taxSystem} onChange={(e) => set({ taxSystem: e.target.value })}>
                {TAX_SYSTEMS.map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}
              </select>
            </label>
            <label className="block text-sm sm:col-span-2">
              <span className="label">{t('invoicing.use')}</span>
              <select className="input" value={fiscal.use} onChange={(e) => set({ use: e.target.value })}>
                {CFDI_USES.map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}
              </select>
            </label>
            <label className="block text-sm sm:col-span-2"><span className="label">{t('customers.email')}</span><input type="email" className="input" value={fiscal.email ?? ''} onChange={(e) => set({ email: e.target.value })} /></label>
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> {t('invoicing.saveFiscal')}</label>
          </div>
        )}
        <ErrorText error={issue.error} ns="invoicing" />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={issue.isPending}>{issue.isPending ? t('common.loading') : t('invoicing.issue')}</button>
        </div>
      </form>
    </Modal>
  );
}
