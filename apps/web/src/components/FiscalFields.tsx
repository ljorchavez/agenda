import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CFDI_USES,
  TAX_SYSTEMS,
  invoicingDefaultsFor,
  type CsfReadDto,
  type CustomerDto,
  type CustomerFiscal,
  type FiscalDocDto,
} from '@agenda/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ErrorText } from './ui';

export interface FiscalForm {
  rfc: string;
  legalName: string;
  taxSystem: string;
  zip: string;
  use: string;
  email: string;
}

export function useFiscalForm(customer?: CustomerDto) {
  const { tenant } = useAuth();
  const defaultUse = invoicingDefaultsFor(tenant?.businessType ?? '').use;
  const f = customer?.fiscal;
  return useState<FiscalForm>({
    rfc: f?.rfc ?? '',
    legalName: f?.legalName ?? '',
    taxSystem: f?.taxSystem ?? '612',
    zip: f?.zip ?? '',
    use: f?.use ?? defaultUse,
    email: f?.email ?? '',
  });
}

/** What goes to the API: nothing filled = no fiscal data. */
export function fiscalPayload(f: FiscalForm): CustomerFiscal | null {
  if (!f.rfc.trim()) return null;
  return {
    rfc: f.rfc.trim().toUpperCase(),
    legalName: f.legalName.trim(),
    taxSystem: f.taxSystem,
    zip: f.zip.trim(),
    use: f.use,
    email: f.email.trim() || null,
  };
}

const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';

/**
 * "Datos para facturar" inside the customer form, with "Subir constancia":
 * reads the SAT's PDF and fills the fields to review. For an existing customer the file is kept;
 * for a new one it's handed to `onPendingFile` and uploaded once the customer exists.
 */
export function FiscalFields({
  value,
  onChange,
  customer,
  onPendingFile,
}: {
  value: FiscalForm;
  onChange: (f: FiscalForm) => void;
  customer?: CustomerDto;
  onPendingFile?: (file: File | null) => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(Boolean(customer?.fiscal));
  const [read, setRead] = useState<(CsfReadDto & { stored?: boolean; fileName: string }) | null>(null);
  const set = (k: keyof FiscalForm) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      if (customer) {
        const r = await api<{ doc: FiscalDocDto | null; read: CsfReadDto; stored: boolean }>(`/customers/${customer.id}/fiscal-doc`, { method: 'POST', body: fd });
        void qc.invalidateQueries({ queryKey: ['customer', customer.id] });
        return { ...r.read, stored: r.stored, fileName: file.name };
      }
      const r = await api<CsfReadDto>('/customers/csf/read', { method: 'POST', body: fd });
      onPendingFile?.(file);
      return { ...r, fileName: file.name };
    },
    onSuccess: (r) => {
      setRead(r);
      setOpen(true);
      const found = Object.fromEntries(Object.entries(r.fiscal).filter(([, v]) => v)) as Partial<FiscalForm>;
      if (Object.keys(found).length) onChange({ ...value, ...found });
    },
  });

  const required = Boolean(value.rfc.trim());
  const missing = read?.warnings.filter((w) => w.startsWith('missing_')).map((w) => t(`fiscal.field.${w.slice(8)}`)) ?? [];

  return (
    <div className="rounded-lg border border-slate-200 p-3" data-testid="fiscal-fields">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="font-medium text-slate-800" onClick={() => setOpen((o) => !o)} data-testid="fiscal-toggle">
          {open ? '▾' : '▸'} {t('fiscal.title')} <span className="font-normal text-slate-400">({t('common.optional')})</span>
        </button>
        <button type="button" className="btn-secondary !px-3 !py-1.5 text-sm" disabled={upload.isPending} onClick={() => input.current?.click()} data-testid="fiscal-upload">
          {upload.isPending ? t('fiscal.reading') : t('fiscal.upload')}
        </button>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          className="hidden"
          data-testid="fiscal-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) upload.mutate(file);
          }}
        />
      </div>
      <ErrorText error={upload.error} ns="fiscal" />

      {read && (
        <div className="mt-2 space-y-1 rounded-md bg-slate-50 p-2 text-sm" data-testid="fiscal-read">
          {read.warnings.includes('no_text') ? (
            <p className="text-amber-700">{t('fiscal.noText')}</p>
          ) : read.warnings.includes('not_csf') ? (
            <p className="text-amber-700">{t('fiscal.notCsf')}</p>
          ) : (
            <p className="text-emerald-700">{t('fiscal.filled')}</p>
          )}
          {missing.length > 0 && !read.warnings.includes('no_text') && <p className="text-amber-700">{t('fiscal.missing', { fields: missing.join(', ') })}</p>}
          {read.warnings.includes('inactive') && <p className="text-amber-700">{t('fiscal.inactive', { status: read.status ?? '' })}</p>}
          {read.regimes.length > 1 && <p className="text-slate-600">{t('fiscal.severalRegimes', { list: read.regimes.join(', ') })}</p>}
          {customer && read.stored === false && <p className="text-slate-500">{t('fiscal.notStored')}</p>}
          {!customer && <p className="text-slate-500">{t('fiscal.willStore', { name: read.fileName })}</p>}
        </div>
      )}

      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">RFC</label>
              <input
                className="input uppercase"
                maxLength={13}
                value={value.rfc}
                onChange={(e) => onChange({ ...value, rfc: e.target.value.toUpperCase().replace(/\s/g, '') })}
                data-testid="fiscal-rfc"
              />
            </div>
            <div>
              <label className="label">{t('invoicing.zip')}</label>
              <input className="input" inputMode="numeric" maxLength={5} pattern="\d{5}" required={required} value={value.zip} onChange={set('zip')} data-testid="fiscal-zip" />
            </div>
          </div>
          <div>
            <label className="label">{t('invoicing.legalName')}</label>
            <input className="input" required={required} minLength={2} value={value.legalName} onChange={set('legalName')} data-testid="fiscal-name" />
            <p className="mt-1 text-xs text-slate-500">{t('invoicing.legalNameHelp')}</p>
          </div>
          <div>
            <label className="label">{t('invoicing.taxSystem')}</label>
            <select className="input" value={value.taxSystem} onChange={set('taxSystem')} data-testid="fiscal-regime">
              {TAX_SYSTEMS.map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">{t('invoicing.use')}</label>
              <select className="input" value={value.use} onChange={set('use')} data-testid="fiscal-use">
                {CFDI_USES.map(([c, n]) => <option key={c} value={c}>{c} · {n}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{t('fiscal.email')}</label>
              <input type="email" className="input" placeholder={t('fiscal.emailHint')} value={value.email} onChange={set('email')} data-testid="fiscal-email" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Opens a private file (needs the session) in a new tab. */
export async function openPrivateFile(path: string) {
  const win = window.open('', '_blank');
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'lugali' } });
  if (!res.ok) {
    win?.close();
    return;
  }
  const url = URL.createObjectURL(await res.blob());
  if (win) win.location.href = url;
  else window.location.href = url;
}

/** Fiscal data card on the customer page. */
export function FiscalSummary({ customer, onEdit }: { customer: CustomerDto; onEdit: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const f = customer.fiscal;
  const doc = customer.fiscalDoc;
  const remove = useMutation({
    mutationFn: () => api(`/customers/${customer.id}/fiscal-doc`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customer', customer.id] }),
  });
  const regime = f ? TAX_SYSTEMS.find(([c]) => c === f.taxSystem)?.[1] : null;
  return (
    <section className="card" data-testid="fiscal-summary">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">{t('fiscal.title')}</h2>
        <button className="text-sm text-brand-700 hover:underline" onClick={onEdit}>{f ? t('common.edit') : t('fiscal.add')}</button>
      </div>
      {f ? (
        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-500">RFC</dt>
          <dd className="font-mono" data-testid="fiscal-summary-rfc">{f.rfc}</dd>
          <dt className="text-slate-500">{t('fiscal.field.legalName')}</dt>
          <dd>{f.legalName}</dd>
          <dt className="text-slate-500">{t('fiscal.field.taxSystem')}</dt>
          <dd>{f.taxSystem}{regime ? ` · ${regime}` : ''}</dd>
          <dt className="text-slate-500">{t('fiscal.field.zip')}</dt>
          <dd>{f.zip}</dd>
          <dt className="text-slate-500">{t('invoicing.use')}</dt>
          <dd>{f.use}</dd>
          {f.email && (
            <>
              <dt className="text-slate-500">{t('fiscal.email')}</dt>
              <dd>{f.email}</dd>
            </>
          )}
        </dl>
      ) : (
        <p className="text-sm text-slate-500">{t('fiscal.none')}</p>
      )}
      {doc && (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3 text-sm">
          <button className="text-brand-700 hover:underline" onClick={() => void openPrivateFile(`/customers/${customer.id}/fiscal-doc`)} data-testid="fiscal-doc-open">
            📄 {t('fiscal.viewDoc')}
          </button>
          <span className="text-xs text-slate-400">{new Date(doc.uploadedAt).toLocaleDateString()}</span>
          <button className="text-xs text-rose-700 hover:underline" onClick={() => window.confirm(t('fiscal.deleteDocConfirm')) && remove.mutate()}>
            {t('common.delete')}
          </button>
        </div>
      )}
    </section>
  );
}
