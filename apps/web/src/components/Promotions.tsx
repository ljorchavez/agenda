import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CouponDto, RewardSettings } from '@agenda/shared';
import { api } from '../lib/api';
import { money, toCents } from '../lib/format';
import { ErrorText } from './ui';

const offText = (type: 'percent' | 'amount', value: number) => (type === 'percent' ? `${value}%` : money(value));

/** Loyalty reward: every N completed visits, the next booking gets a discount. */
export function RewardsSection({ value, onChange, disabled }: { value: RewardSettings; onChange: (r: RewardSettings) => void; disabled: boolean }) {
  const { t } = useTranslation();
  const set = (p: Partial<RewardSettings>) => onChange({ ...value, ...p });
  return (
    <section className="card space-y-4" data-testid="rewards-section">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">🎁 {t('promos.rewardsTitle')}</h2>
          <p className="text-sm text-slate-500">{t('promos.rewardsHelp')}</p>
        </div>
        <input type="checkbox" aria-label={t('promos.rewardsTitle')} className="mt-1 h-5 w-5 accent-teal-700" disabled={disabled} checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
      </div>
      {value.enabled && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label" htmlFor="rw-every">{t('promos.everyVisits')}</label>
              <input id="rw-every" type="number" min={2} max={50} className="input" disabled={disabled} value={value.everyVisits} onChange={(e) => set({ everyVisits: Math.max(2, Number(e.target.value) || 2) })} />
            </div>
            <div>
              <label className="label" htmlFor="rw-type">{t('promos.discount')}</label>
              <select id="rw-type" className="input" disabled={disabled} value={value.discountType} onChange={(e) => set({ discountType: e.target.value as 'percent' | 'amount', value: e.target.value === 'percent' ? 10 : 5000 })}>
                <option value="percent">%</option>
                <option value="amount">$ MXN</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="rw-value">{t('promos.value')}</label>
              <input
                id="rw-value"
                type="number"
                min={1}
                max={value.discountType === 'percent' ? 100 : undefined}
                className="input"
                disabled={disabled}
                value={value.discountType === 'percent' ? value.value : value.value / 100}
                onChange={(e) => set({ value: value.discountType === 'percent' ? Math.min(100, Math.max(1, Number(e.target.value) || 1)) : Math.max(100, toCents(e.target.value || '1')) })}
              />
            </div>
          </div>
          <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
            {t('promos.rewardExample', { count: value.everyVisits, next: value.everyVisits + 1, off: offText(value.discountType, value.value) })}
          </p>
        </>
      )}
    </section>
  );
}

type Form = { id?: string; code: string; discountType: 'percent' | 'amount'; value: string; maxUses: string; validUntil: string; active: boolean };
const EMPTY: Form = { code: '', discountType: 'percent', value: '10', maxUses: '', validUntil: '', active: true };

/** Discount codes: turn on, create, pause or delete them; shows how many times each was used. */
export function CouponsSection({ enabled, onToggle, disabled }: { enabled: boolean; onToggle: (on: boolean) => void; disabled: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['coupons'], queryFn: () => api<CouponDto[]>('/coupons') });
  const [form, setForm] = useState<Form | null>(null);
  const save = useMutation({
    mutationFn: (f: Form) =>
      api<CouponDto>(f.id ? `/coupons/${f.id}` : '/coupons', {
        method: f.id ? 'PUT' : 'POST',
        body: {
          code: f.code,
          discountType: f.discountType,
          value: f.discountType === 'percent' ? Number(f.value) : toCents(f.value),
          active: f.active,
          maxUses: f.maxUses ? Number(f.maxUses) : null,
          validUntil: f.validUntil || null,
        },
      }),
    onSuccess: () => {
      setForm(null);
      void qc.invalidateQueries({ queryKey: ['coupons'] });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/coupons/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['coupons'] }),
  });
  const toggleActive = (c: CouponDto) =>
    save.mutate({ id: c.id, code: c.code, discountType: c.discountType, value: String(c.discountType === 'percent' ? c.value : c.value / 100), maxUses: c.maxUses ? String(c.maxUses) : '', validUntil: c.validUntil ?? '', active: !c.active });

  return (
    <section className="card space-y-4" data-testid="coupons-section">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">🏷️ {t('promos.couponsTitle')}</h2>
          <p className="text-sm text-slate-500">{t('promos.couponsHelp')}</p>
        </div>
        <input type="checkbox" aria-label={t('promos.couponsTitle')} className="mt-1 h-5 w-5 accent-teal-700" disabled={disabled} checked={enabled} onChange={(e) => onToggle(e.target.checked)} />
      </div>
      {enabled && (
        <>
          {(list.data ?? []).length > 0 && (
            <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
              {list.data!.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className={c.active ? '' : 'opacity-50'}>
                    <span className="font-mono font-semibold">{c.code}</span>
                    <span className="ml-2 text-slate-600">−{offText(c.discountType, c.value)}</span>
                    <span className="ml-2 text-xs text-slate-500">
                      {t('promos.uses', { count: c.uses })}{c.maxUses ? ` / ${c.maxUses}` : ''}
                      {c.validUntil && ` · ${t('promos.until', { date: c.validUntil })}`}
                    </span>
                  </div>
                  {!disabled && (
                    <div className="flex gap-3 text-xs">
                      <button type="button" className="text-slate-600 hover:underline" onClick={() => toggleActive(c)}>{c.active ? t('promos.pause') : t('promos.resume')}</button>
                      <button type="button" className="text-brand-700 hover:underline" onClick={() => setForm({ id: c.id, code: c.code, discountType: c.discountType, value: String(c.discountType === 'percent' ? c.value : c.value / 100), maxUses: c.maxUses ? String(c.maxUses) : '', validUntil: c.validUntil ?? '', active: c.active })}>{t('common.edit')}</button>
                      <button type="button" className="text-rose-700 hover:underline" onClick={() => window.confirm(t('promos.deleteConfirm', { code: c.code })) && remove.mutate(c.id)}>{t('common.delete')}</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {form ? (
            <form
              className="space-y-3 rounded-lg border border-slate-200 p-3"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate(form);
              }}
            >
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="col-span-2 sm:col-span-1">
                  <label className="label" htmlFor="cp-code">{t('promos.code')}</label>
                  <input id="cp-code" required minLength={3} maxLength={30} pattern="[A-Za-z0-9_\-]+" className="input font-mono uppercase" placeholder="VERANO10" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
                </div>
                <div>
                  <label className="label" htmlFor="cp-type">{t('promos.discount')}</label>
                  <select id="cp-type" className="input" value={form.discountType} onChange={(e) => setForm({ ...form, discountType: e.target.value as Form['discountType'] })}>
                    <option value="percent">%</option>
                    <option value="amount">$ MXN</option>
                  </select>
                </div>
                <div>
                  <label className="label" htmlFor="cp-value">{t('promos.value')}</label>
                  <input id="cp-value" required type="number" min={1} max={form.discountType === 'percent' ? 100 : undefined} step="any" className="input" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
                </div>
                <div>
                  <label className="label" htmlFor="cp-max">{t('promos.maxUses')}</label>
                  <input id="cp-max" type="number" min={1} className="input" placeholder="∞" value={form.maxUses} onChange={(e) => setForm({ ...form, maxUses: e.target.value })} />
                </div>
                <div className="col-span-2">
                  <label className="label" htmlFor="cp-until">{t('promos.validUntil')}</label>
                  <input id="cp-until" type="date" className="input" value={form.validUntil} onChange={(e) => setForm({ ...form, validUntil: e.target.value })} />
                </div>
              </div>
              <ErrorText error={save.error} ns="promos" />
              <div className="flex justify-end gap-2">
                <button type="button" className="btn-secondary" onClick={() => setForm(null)}>{t('common.cancel')}</button>
                <button className="btn-primary" disabled={save.isPending}>{t('common.save')}</button>
              </div>
            </form>
          ) : (
            !disabled && <button type="button" className="btn-secondary" onClick={() => setForm({ ...EMPTY })}>+ {t('promos.newCoupon')}</button>
          )}
        </>
      )}
    </section>
  );
}
