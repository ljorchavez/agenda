import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { BUSINESS_TYPES, type AuthResponse, type BusinessType } from '@agenda/shared';
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
        <div>
          <label className="label" htmlFor="nb-name">{t('auth.businessName')}</label>
          <input id="nb-name" required minLength={2} className="input" value={form.businessName} onChange={(e) => setForm({ ...form, businessName: e.target.value })} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="nb-type">{t('auth.businessType')}</label>
            <select id="nb-type" className="input" value={form.businessType} onChange={(e) => setForm({ ...form, businessType: e.target.value as BusinessType })}>
              {BUSINESS_TYPES.map((b) => <option key={b} value={b}>{t(`businessTypes.${b}`)}</option>)}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="nb-phone">{t('auth.phone')}</label>
            <input id="nb-phone" type="tel" className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
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
