import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { BUSINESS_TYPES, type AuthResponse, type BusinessType } from '@agenda/shared';
import { LanguageSwitch } from '../components/Layout';
import { ErrorText } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 to-slate-100 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <div className="text-2xl font-bold text-brand-700">Agenda</div>
            <p className="text-sm text-slate-600">{t('auth.tagline')}</p>
          </div>
          <LanguageSwitch />
        </div>
        <div className="card">
          <h1 className="mb-4 text-xl font-semibold">{title}</h1>
          {children}
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const { t } = useTranslation();
  const { user, setSession } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api<AuthResponse>('/auth/login', { method: 'POST', body: { email, password } }),
    onSuccess: (res) => {
      setSession(res);
      navigate('/');
    },
  });

  if (user) return <Navigate to="/" replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <AuthShell title={t('auth.login')}>
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label" htmlFor="email">{t('auth.email')}</label>
          <input id="email" type="email" required autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="password">{t('auth.password')}</label>
          <input id="password" type="password" required autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <ErrorText error={login.error} ns="auth" />
        <button className="btn-primary w-full" disabled={login.isPending}>
          {login.isPending ? t('common.loading') : t('auth.login')}
        </button>
        <p className="text-center text-sm text-slate-600">
          {t('auth.noAccount')}{' '}
          <Link to="/register" className="font-medium text-brand-700 hover:underline">{t('auth.register')}</Link>
        </p>
      </form>
    </AuthShell>
  );
}

export function RegisterPage() {
  const { t, i18n } = useTranslation();
  const { user, setSession } = useAuth();
  const navigate = useNavigate();
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
          locale: i18n.language.startsWith('en') ? 'en' : 'es',
        },
      }),
    onSuccess: (res) => {
      setSession(res);
      navigate('/services');
    },
  });

  if (user) return <Navigate to="/" replace />;

  return (
    <AuthShell title={t('auth.register')}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          register.mutate();
        }}
        className="space-y-4"
      >
        <div>
          <label className="label">{t('auth.businessName')}</label>
          <input required minLength={2} className="input" value={form.businessName} onChange={set('businessName')} />
        </div>
        <div>
          <label className="label">{t('auth.businessType')}</label>
          <select className="input" value={form.businessType} onChange={set('businessType')}>
            {BUSINESS_TYPES.map((b) => (
              <option key={b} value={b}>{t(`businessTypes.${b}`)}</option>
            ))}
          </select>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="label">{t('auth.name')}</label>
            <input required minLength={2} className="input" value={form.name} onChange={set('name')} />
          </div>
          <div>
            <label className="label">{t('auth.phone')}</label>
            <input type="tel" className="input" value={form.phone} onChange={set('phone')} />
          </div>
        </div>
        <div>
          <label className="label">{t('auth.email')}</label>
          <input type="email" required autoComplete="email" className="input" value={form.email} onChange={set('email')} />
        </div>
        <div>
          <label className="label">{t('auth.password')}</label>
          <input type="password" required minLength={8} autoComplete="new-password" className="input" value={form.password} onChange={set('password')} />
          <p className="mt-1 text-xs text-slate-500">{t('auth.passwordHint')}</p>
        </div>
        <ErrorText error={register.error} ns="auth" />
        <button className="btn-primary w-full" disabled={register.isPending}>
          {register.isPending ? t('common.loading') : t('auth.register')}
        </button>
        <p className="text-center text-sm text-slate-600">
          {t('auth.haveAccount')}{' '}
          <Link to="/login" className="font-medium text-brand-700 hover:underline">{t('auth.login')}</Link>
        </p>
      </form>
    </AuthShell>
  );
}
