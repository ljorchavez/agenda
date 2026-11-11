import { BusinessTypePicker } from '../components/BusinessTypePicker';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { ADDON_PRICES, type AuthResponse, type BusinessType } from '@agenda/shared';
import { money } from '../lib/format';
import { ErrorText, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

/** A signed-in person opens another business; they become its owner and it's billed on its own plan. */
export function NewBusinessPage() {
  const { t } = useTranslation();
  const { setSession, businesses } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ businessName: '', businessType: 'barbershop' as BusinessType, phone: '' });
  const create = useMutation({
    mutationFn: () =>
      api<AuthResponse>('/businesses', { method: 'POST', body: { ...form, phone: form.phone || undefined } }),
    onSuccess: (res) => {
      setSession(res);
      navigate('/settings');
    },
  });
  return (
    <>
      <PageHeader title={t('business.newTitle')} />
      <form
        className="card max-w-xl space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <p className="text-sm text-slate-600">{t('business.newHelp', { count: businesses.length })}</p>
        <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{t('plans.newBusinessNote', { price: money(ADDON_PRICES.extraBusinessCents) })}</p>
        <div>
          <label className="label" htmlFor="nb-name">{t('auth.businessName')}</label>
          <input id="nb-name" required minLength={2} className="input" value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} />
        </div>
        <div>
          <span className="label">{t('auth.businessType')}</span>
          <BusinessTypePicker id="nb-type" value={form.businessType} onChange={(b) => setForm({ ...form, businessType: b })} />
        </div>
        <div>
          <label className="label" htmlFor="nb-phone">{t('auth.phone')}</label>
          <input id="nb-phone" type="tel" className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <ErrorText error={create.error} ns="auth" />
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" onClick={() => navigate(-1)}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={create.isPending}>{t('business.create')}</button>
        </div>
      </form>
    </>
  );
}
