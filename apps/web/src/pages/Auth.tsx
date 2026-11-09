import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { BUSINESS_TYPES, SELECTABLE_PLANS, type AuthResponse, type BusinessType, type PlanId } from '@agenda/shared';
import { LanguageSwitch } from '../components/Layout';
import { PlanCards, PlanExtras } from '../components/Plans';
import { ErrorText, Modal } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

/** Sign-in form; lives in a floating window over the home page. */
export function LoginForm({ onDone }: { onDone?: () => void }) {
  const { t } = useTranslation();
  const { setSession } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api<AuthResponse>('/auth/login', { method: 'POST', body: { email, password } }),
    onSuccess: (res) => {
      setSession(res);
      onDone?.();
      navigate('/inicio');
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label className="label" htmlFor="email">{t('auth.email')}</label>
        <input id="email" type="email" required autoFocus autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="password">{t('auth.password')}</label>
        <input id="password" type="password" required autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <ErrorText error={login.error} ns="auth" />
      <button type="submit" className="btn-primary w-full" disabled={login.isPending}>
        {login.isPending ? t('common.loading') : t('auth.login')}
      </button>
      <p className="text-center text-sm text-slate-600">
        {t('auth.noAccount')}{' '}
        <Link to="/registro" className="font-medium text-brand-700 hover:underline" onClick={onDone}>{t('auth.register')}</Link>
      </p>
    </form>
  );
}

export function LoginModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal open title={t('auth.login')} onClose={onClose}>
      <LoginForm onDone={onClose} />
    </Modal>
  );
}

/** Create account: first the plan, then the business and owner details. */
export function RegisterPage() {
  const { t, i18n } = useTranslation();
  const { user, setSession } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const chosen = params.get('plan') as PlanId | null;
  const plan = chosen && SELECTABLE_PLANS.includes(chosen) ? chosen : null;
  const [form, setForm] = useState({
    businessName: '',
    businessType: 'nutrition' as BusinessType,
    name: '',
    phone: '',
    email: '',
    password: '',
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const register = useMutation({
    mutationFn: () =>
      api<AuthResponse>('/auth/register', {
        method: 'POST',
        body: {
          ...form,
          phone: form.phone || undefined,
          plan,
          locale: i18n.language.startsWith('en') ? 'en' : 'es',
        },
      }),
    onSuccess: (res) => {
      setSession(res);
      navigate('/services');
    },
  });

  if (user) return <Navigate to="/inicio" replace />;

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 to-slate-100 px-4 py-6">
      <div className={`mx-auto ${plan ? 'max-w-md' : 'max-w-5xl'}`}>
        <div className="mb-6 flex items-center justify-between">
          <Link to="/" className="text-2xl font-bold text-brand-700">Agenda</Link>
          <LanguageSwitch />
        </div>
        {!plan ? (
          <>
            <h1 className="text-2xl font-bold text-slate-900">{t('plans.title')}</h1>
            <p className="mb-5 text-slate-600">{t('plans.subtitle')}</p>
            <PlanCards onPick={(p) => setParams({ plan: p })} />
            <PlanExtras />
            <p className="mt-6 text-center text-sm text-slate-600">
              {t('auth.haveAccount')}{' '}
              <Link to="/?login=1" className="font-medium text-brand-700 hover:underline">{t('auth.login')}</Link>
            </p>
          </>
        ) : (
          <div className="card">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h1 className="text-xl font-semibold">{t('auth.register')}</h1>
              <button type="button" className="text-sm font-medium text-brand-700" onClick={() => setParams({})}>
                {t(`plans.${plan}`)} · {t('plans.change')}
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                register.mutate();
              }}
              className="space-y-4"
            >
              <div>
                <label className="label" htmlFor="r-biz">{t('auth.businessName')}</label>
                <input id="r-biz" required minLength={2} className="input" value={form.businessName} onChange={set('businessName')} />
              </div>
              <div>
                <label className="label" htmlFor="r-type">{t('auth.businessType')}</label>
                <select id="r-type" className="input" value={form.businessType} onChange={set('businessType')}>
                  {BUSINESS_TYPES.map((b) => (
                    <option key={b} value={b}>{t(`businessTypes.${b}`)}</option>
                  ))}
                </select>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="label" htmlFor="r-name">{t('auth.name')}</label>
                  <input id="r-name" required minLength={2} className="input" value={form.name} onChange={set('name')} />
                </div>
                <div>
                  <label className="label" htmlFor="r-phone">{t('auth.phone')}</label>
                  <input id="r-phone" type="tel" className="input" value={form.phone} onChange={set('phone')} />
                </div>
              </div>
              <div>
                <label className="label" htmlFor="r-email">{t('auth.email')}</label>
                <input id="r-email" type="email" required autoComplete="email" className="input" value={form.email} onChange={set('email')} />
              </div>
              <div>
                <label className="label" htmlFor="r-pass">{t('auth.password')}</label>
                <input id="r-pass" type="password" required minLength={8} autoComplete="new-password" className="input" value={form.password} onChange={set('password')} />
                <p className="mt-1 text-xs text-slate-500">{t('auth.passwordHint')}</p>
              </div>
              {plan !== 'free' && <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{t('plans.billingSoon')}</p>}
              <ErrorText error={register.error} ns="auth" />
              <button className="btn-primary w-full" disabled={register.isPending}>
                {register.isPending ? t('common.loading') : t('auth.register')}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
