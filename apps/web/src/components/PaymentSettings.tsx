import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import {
  computeDepositCents,
  isValidClabe,
  type PaymentMethod,
  type PaymentSettings,
  type TenantDto,
} from '@agenda/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { money, toCents } from '../lib/format';
import { ErrorText } from './ui';

const OFFLINE: PaymentMethod[] = ['cash', 'card', 'transfer'];
const ONLINE: PaymentMethod[] = ['mercadopago', 'spei'];

function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <label className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${disabled ? 'opacity-50' : ''} ${checked ? 'border-brand-600 bg-brand-50' : 'border-slate-200'}`}>
      <span>{label}</span>
      <input type="checkbox" className="h-4 w-4 accent-teal-700" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** Payment methods + deposit policy. Edits the `payments` part of the tenant settings. */
export function PaymentSettingsSection({
  value,
  onChange,
  disabled,
}: {
  value: PaymentSettings;
  onChange: (v: PaymentSettings) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const { tenant, setTenant } = useAuth();
  const [token, setToken] = useState('');
  const mp = tenant?.mercadoPago;

  const connect = useMutation({
    mutationFn: () => api<TenantDto>('/tenant/mercadopago', { method: 'PUT', body: { accessToken: token } }),
    onSuccess: (tn) => {
      setTenant(tn);
      setToken('');
    },
  });
  const disconnect = useMutation({
    mutationFn: () => api<TenantDto>('/tenant/mercadopago', { method: 'DELETE' }),
    onSuccess: (tn) => {
      setTenant(tn);
      onChange({ ...value, methods: { ...value.methods, mercadopago: false, spei: false } });
    },
  });

  const setMethod = (m: PaymentMethod, on: boolean) => onChange({ ...value, methods: { ...value.methods, [m]: on } });
  const d = value.deposit;
  const setDeposit = (patch: Partial<PaymentSettings['deposit']>) => onChange({ ...value, deposit: { ...d, ...patch } });
  const clabeError = value.transfer.clabe !== '' && !isValidClabe(value.transfer.clabe);
  const exampleCents = 70000;

  return (
    <>
      <section className="card space-y-4">
        <div>
          <h2 className="font-semibold">{t('paymentSettings.title')}</h2>
          <p className="text-sm text-slate-500">{t('paymentSettings.subtitle')}</p>
        </div>

        <div className="grid gap-2 sm:grid-cols-3">
          {OFFLINE.map((m) => (
            <Toggle key={m} label={t(`methods.${m}`)} checked={value.methods[m]} disabled={disabled} onChange={(v) => setMethod(m, v)} />
          ))}
        </div>

        {value.methods.transfer && (
          <div className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-3">
            <div>
              <label className="label">{t('paymentSettings.bank')}</label>
              <input className="input" disabled={disabled} value={value.transfer.bank} onChange={(e) => onChange({ ...value, transfer: { ...value.transfer, bank: e.target.value } })} />
            </div>
            <div>
              <label className="label">{t('paymentSettings.holder')}</label>
              <input className="input" disabled={disabled} value={value.transfer.accountHolder} onChange={(e) => onChange({ ...value, transfer: { ...value.transfer, accountHolder: e.target.value } })} />
            </div>
            <div>
              <label className="label">CLABE</label>
              <input
                className={`input ${clabeError ? 'border-rose-400' : ''}`}
                inputMode="numeric"
                maxLength={18}
                disabled={disabled}
                value={value.transfer.clabe}
                onChange={(e) => onChange({ ...value, transfer: { ...value.transfer, clabe: e.target.value.replace(/\D/g, '') } })}
              />
              {clabeError && <p className="mt-1 text-xs text-rose-600">{t('paymentSettings.invalidClabe')}</p>}
            </div>
          </div>
        )}

        <div className="rounded-lg border border-slate-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-medium">Mercado Pago</div>
            <span className={`rounded-full px-2 py-0.5 text-xs ${mp?.connected ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
              {mp?.connected ? t('paymentSettings.connected') : t('paymentSettings.notConnected')}
            </span>
          </div>
          {mp?.connected ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-slate-600">{mp.account}</span>
              {!disabled && (
                <button type="button" className="text-rose-700 hover:underline" onClick={() => window.confirm(t('paymentSettings.disconnectConfirm')) && disconnect.mutate()}>
                  {t('paymentSettings.disconnect')}
                </button>
              )}
            </div>
          ) : (
            !disabled && (
              <div className="space-y-2">
                <p className="text-xs text-slate-500">{t('paymentSettings.tokenHelp')}</p>
                <div className="flex gap-2">
                  <input className="input" placeholder="APP_USR-..." value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
                  <button type="button" className="btn-secondary" disabled={token.length < 20 || connect.isPending} onClick={() => connect.mutate()}>
                    {t('paymentSettings.connect')}
                  </button>
                </div>
                <ErrorText error={connect.error} ns="paymentSettings" />
              </div>
            )
          )}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {ONLINE.map((m) => (
              <Toggle key={m} label={t(`paymentSettings.online.${m}`)} checked={value.methods[m]} disabled={disabled || !mp?.connected} onChange={(v) => setMethod(m, v)} />
            ))}
          </div>
        </div>
      </section>

      {/* Right column: deposit and no-shows stacked, so the page doesn't grow downwards */}
      <div className="space-y-6">
      <section className="card space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">{t('paymentSettings.deposit')}</h2>
            <p className="text-sm text-slate-500">{t('paymentSettings.depositHelp')}</p>
          </div>
          <input type="checkbox" aria-label={t('paymentSettings.deposit')} className="mt-1 h-5 w-5 accent-teal-700" disabled={disabled} checked={d.enabled} onChange={(e) => setDeposit({ enabled: e.target.checked })} />
        </div>
        {d.enabled && (
          <>
            <div className="flex flex-wrap gap-2">
              {(['percent', 'fixed'] as const).map((tp) => (
                <button
                  key={tp}
                  type="button"
                  disabled={disabled}
                  onClick={() => setDeposit({ type: tp, value: tp === 'percent' ? 50 : 20000 })}
                  className={`rounded-lg border px-3 py-1.5 text-sm ${d.type === tp ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 text-slate-600'}`}
                >
                  {t(`paymentSettings.type.${tp}`)}
                </button>
              ))}
            </div>
            <div className="max-w-56">
              <label className="label">{d.type === 'percent' ? t('paymentSettings.percent') : t('paymentSettings.amount')}</label>
              {d.type === 'percent' ? (
                <input type="number" min={1} max={100} className="input" disabled={disabled} value={d.value} onChange={(e) => setDeposit({ value: Math.max(0, Math.min(100, Math.round(Number(e.target.value)))) })} />
              ) : (
                <input type="number" min={0} step="0.01" className="input" disabled={disabled} value={d.value / 100} onChange={(e) => setDeposit({ value: toCents(e.target.value || 0) })} />
              )}
            </div>
            <p className="text-sm text-slate-600">
              {t('paymentSettings.example', { price: money(exampleCents), deposit: money(computeDepositCents(exampleCents, value)) })}
            </p>
            {!value.methods.mercadopago && !value.methods.spei && !(value.methods.transfer && value.transfer.clabe) && (
              <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-800">{t('paymentSettings.noDepositMethod')}</p>
            )}
          </>
        )}
      </section>

      <section className="card space-y-3">
        <div>
          <h2 className="font-semibold">{t('paymentSettings.noShowTitle')}</h2>
          <p className="text-sm text-slate-500">{t('paymentSettings.noShowHelp')}</p>
        </div>
        <div className="flex flex-col gap-2 text-sm sm:flex-row sm:gap-6" role="radiogroup" aria-label={t('paymentSettings.noShowTitle')}>
          <label className="flex items-center gap-2">
            <input type="radio" name="no-show" disabled={disabled} checked={value.noShowOwes !== false} onChange={() => onChange({ ...value, noShowOwes: true })} />
            <span><span className="font-medium">{t('paymentSettings.noShowOwes')}</span> <span className="rounded bg-rose-600 px-1 text-[10px] font-bold text-white">$!</span></span>
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="no-show" disabled={disabled} checked={value.noShowOwes === false} onChange={() => onChange({ ...value, noShowOwes: false })} />
            <span className="font-medium">{t('paymentSettings.noShowFree')}</span>
          </label>
        </div>
      </section>
      </div>
    </>
  );
}
