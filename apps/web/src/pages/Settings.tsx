import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BUSINESS_TYPES,
  isValidClabe,
  paymentSettingsOf,
  type SessionUser,
  type TenantDto,
  type TenantSettings,
} from '@agenda/shared';
import { PaymentSettingsSection } from '../components/PaymentSettings';
import { ErrorText, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

export function SettingsPage() {
  const { t, i18n } = useTranslation();
  const { tenant, user, setTenant } = useAuth();
  const isOwner = user?.role === 'owner';
  const [name, setName] = useState(tenant?.name ?? '');
  const [businessType, setBusinessType] = useState(tenant?.businessType ?? 'other');
  const [phone, setPhone] = useState(tenant?.phone ?? '');
  const [settings, setSettings] = useState<TenantSettings>({
    ...tenant!.settings,
    payments: paymentSettingsOf(tenant!.settings),
  });
  const payments = settings.payments!;
  const invalid = payments.transfer.clabe !== '' && !isValidClabe(payments.transfer.clabe);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api<TenantDto>('/tenant', {
        method: 'PATCH',
        body: { name, businessType, phone: phone || null, settings, locale: i18n.language.startsWith('en') ? 'en' : 'es' },
      }),
    onSuccess: (t2) => {
      setTenant(t2);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const publicUrl = `${window.location.origin}/b/${tenant?.slug}`;
  const intl = i18n.language.startsWith('en') ? 'en-US' : 'es-MX';
  const dayName = (n: number) => new Intl.DateTimeFormat(intl, { weekday: 'short' }).format(new Date(2024, 0, n));
  const setHours = (patch: Partial<TenantSettings['hours']>) =>
    setSettings((s) => ({ ...s, hours: { ...s.hours, ...patch } }));

  return (
    <>
      <PageHeader title={t('settings.title')} />
      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card space-y-4">
          <h2 className="font-semibold">{t('settings.business')}</h2>
          <div>
            <label className="label">{t('auth.businessName')}</label>
            <input className="input" value={name} disabled={!isOwner} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">{t('auth.businessType')}</label>
              <select className="input" value={businessType} disabled={!isOwner} onChange={(e) => setBusinessType(e.target.value as typeof businessType)}>
                {BUSINESS_TYPES.map((b) => <option key={b} value={b}>{t(`businessTypes.${b}`)}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{t('auth.phone')}</label>
              <input className="input" value={phone} disabled={!isOwner} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
          <div>
            <label className="label">{t('settings.language')}</label>
            <select
              className="input"
              value={i18n.language.startsWith('en') ? 'en' : 'es'}
              onChange={(e) => {
                void i18n.changeLanguage(e.target.value);
                try { localStorage.setItem('agenda.lang', e.target.value); } catch { /* ignore */ }
              }}
            >
              <option value="es">Español</option>
              <option value="en">English</option>
            </select>
          </div>
          <div className="text-sm text-slate-500">{t('settings.timezone')}: {tenant?.timezone}</div>
        </section>

        <section className="card space-y-4">
          <h2 className="font-semibold">{t('settings.publicLink')}</h2>
          <div className="flex gap-2">
            <input readOnly className="input" value={publicUrl} onFocus={(e) => e.target.select()} />
            <button
              className="btn-secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(publicUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? t('common.copied') : t('common.copy')}
            </button>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={!isOwner} checked={settings.onlineBookingEnabled} onChange={(e) => setSettings({ ...settings, onlineBookingEnabled: e.target.checked })} />
            {t('settings.onlineBookingEnabled')}
          </label>

          <h2 className="pt-2 font-semibold">{t('settings.reminders')}</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={!isOwner} checked={settings.remindersEnabled} onChange={(e) => setSettings({ ...settings, remindersEnabled: e.target.checked })} />
            {t('settings.remindersEnabled')}
          </label>
          <div className="max-w-48">
            <label className="label">{t('settings.reminderHoursBefore')}</label>
            <input type="number" min={1} max={72} disabled={!isOwner} className="input" value={settings.reminderHoursBefore} onChange={(e) => setSettings({ ...settings, reminderHoursBefore: Number(e.target.value) })} />
          </div>
        </section>

        <section className="card space-y-4 lg:col-span-2">
          <h2 className="font-semibold">{t('settings.hours')}</h2>
          <div>
            <div className="label">{t('settings.openDays')}</div>
            <div className="flex flex-wrap gap-2">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => {
                const on = settings.hours.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    disabled={!isOwner}
                    onClick={() => setHours({ days: on ? settings.hours.days.filter((x) => x !== d) : [...settings.hours.days, d].sort() })}
                    className={`rounded-lg border px-3 py-1.5 text-sm capitalize ${on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 text-slate-500'}`}
                  >
                    {dayName(d)}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid max-w-xl gap-4 sm:grid-cols-3">
            <div>
              <label className="label">{t('settings.open')}</label>
              <input type="time" disabled={!isOwner} className="input" value={settings.hours.open} onChange={(e) => setHours({ open: e.target.value })} />
            </div>
            <div>
              <label className="label">{t('settings.close')}</label>
              <input type="time" disabled={!isOwner} className="input" value={settings.hours.close} onChange={(e) => setHours({ close: e.target.value })} />
            </div>
            <div>
              <label className="label">{t('settings.slotMinutes')}</label>
              <select disabled={!isOwner} className="input" value={settings.hours.slotMinutes} onChange={(e) => setHours({ slotMinutes: Number(e.target.value) })}>
                {[15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
        </section>

        <PaymentSettingsSection
          value={payments}
          disabled={!isOwner}
          onChange={(p) => setSettings((s) => ({ ...s, payments: p }))}
        />
      </div>

      {isOwner && (
        <div className="mt-6 flex items-center gap-3">
          <button className="btn-primary" disabled={save.isPending || invalid} onClick={() => save.mutate()}>{t('common.save')}</button>
          {saved && <span className="text-sm text-emerald-700">{t('common.saved')}</span>}
          <ErrorText error={save.error} ns="paymentSettings" />
        </div>
      )}

      <TeamSection isOwner={isOwner} />
    </>
  );
}

function TeamSection({ isOwner }: { isOwner: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const team = useQuery({ queryKey: ['users'], queryFn: () => api<SessionUser[]>('/users') });
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const add = useMutation({
    mutationFn: () => api('/users', { method: 'POST', body: { ...form, role: 'staff' } }),
    onSuccess: () => {
      setForm({ name: '', email: '', password: '' });
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
  });
  return (
    <section className="card mt-6">
      <h2 className="mb-3 font-semibold">{t('settings.team')}</h2>
      <ul className="mb-4 divide-y divide-slate-100 text-sm">
        {(team.data ?? []).map((u) => (
          <li key={u.id} className="flex justify-between py-2">
            <span>{u.name} <span className="text-slate-500">· {u.email}</span></span>
            <span className="text-slate-500">{t(`settings.role.${u.role}`)}</span>
          </li>
        ))}
      </ul>
      {isOwner && (
        <form className="grid gap-2 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
          <input required placeholder={t('auth.name')} className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input required type="email" placeholder={t('auth.email')} className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input required type="password" minLength={8} placeholder={t('auth.password')} className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <button className="btn-secondary" disabled={add.isPending}>{t('settings.addMember')}</button>
          <div className="sm:col-span-4"><ErrorText error={add.error} ns="auth" /></div>
        </form>
      )}
    </section>
  );
}
