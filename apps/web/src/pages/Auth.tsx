import { useState, type FormEvent } from 'react';
import { AcceptLegal } from './Legal';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { SELECTABLE_PLANS, type AuthResponse, type BusinessType, type PlanId } from '@agenda/shared';
import { LanguageSwitch } from '../components/Layout';
import { PlanCards, PlanExtras } from '../components/Plans';
import { ErrorText, Modal } from '../components/ui';
import { GoogleButton, googleSignup } from '../components/GoogleButton';
import { BusinessTypePicker } from '../components/BusinessTypePicker';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

/** Sign-in form; lives in a floating window over the home page. */
export function LoginForm({ onDone, onForgot }: { onDone?: () => void; onForgot?: () => void }) {
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
      navigate('/agenda');
    },
  });

  const google = useMutation({
    mutationFn: (credential: string) => api<AuthResponse>('/auth/google', { method: 'POST', body: { credential } }),
    onSuccess: (res) => {
      setSession(res);
      onDone?.();
      navigate('/agenda');
    },
    onError: (err, credential) => {
      // New person: continue to sign-up with the Google email already filled in.
      if (err instanceof ApiError && err.code === 'google_no_account') {
        const d = (err.details ?? {}) as { email?: string; name?: string | null };
        googleSignup.set({ credential, email: d.email ?? '', name: d.name ?? null });
        onDone?.();
        navigate('/registro');
      }
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <GoogleButton onCredential={(c) => google.mutate(c)} />
      {!(google.error instanceof ApiError && google.error.code === 'google_no_account') && <ErrorText error={google.error} ns="auth" />}
      <div>
        <label className="label" htmlFor="email">{t('auth.email')}</label>
        <input id="email" type="email" required autoFocus autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div>
        <label className="label" htmlFor="password">{t('auth.password')}</label>
        <input id="password" type="password" required autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
        {onForgot && (
          <button type="button" className="mt-1 text-sm font-medium text-brand-700 hover:underline" onClick={onForgot}>
            {t('auth.forgot')}
          </button>
        )}
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

/** "Forgot my password": asks for the email and always says the same thing afterwards. */
export function ForgotForm({ onBack }: { onBack: () => void }) {
  const { t, i18n } = useTranslation();
  const [email, setEmail] = useState('');
  const forgot = useMutation({
    mutationFn: () =>
      api<{ ok: true }>('/auth/forgot-password', {
        method: 'POST',
        body: { email, locale: i18n.language.startsWith('en') ? 'en' : 'es' },
      }),
  });

  if (forgot.isSuccess) {
    return (
      <div className="space-y-4">
        <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{t('auth.forgotSent', { email })}</p>
        <button type="button" className="btn-secondary w-full" onClick={onBack}>{t('auth.backToLogin')}</button>
      </div>
    );
  }
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        forgot.mutate();
      }}
    >
      <p className="text-sm text-slate-600">{t('auth.forgotHelp')}</p>
      <div>
        <label className="label" htmlFor="forgot-email">{t('auth.email')}</label>
        <input id="forgot-email" type="email" required autoFocus autoComplete="email" className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <ErrorText error={forgot.error} ns="auth" />
      <button type="submit" className="btn-primary w-full" disabled={forgot.isPending}>
        {forgot.isPending ? t('common.loading') : t('auth.forgotSend')}
      </button>
      <button type="button" className="w-full text-center text-sm font-medium text-brand-700 hover:underline" onClick={onBack}>
        {t('auth.backToLogin')}
      </button>
    </form>
  );
}

export function LoginModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [forgot, setForgot] = useState(false);
  return (
    <Modal open title={forgot ? t('auth.forgotTitle') : t('auth.login')} onClose={onClose}>
      {forgot ? <ForgotForm onBack={() => setForgot(false)} /> : <LoginForm onDone={onClose} onForgot={() => setForgot(true)} />}
    </Modal>
  );
}

/** Page opened from the email link: /restablecer?token=… */
export function ResetPasswordPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const reset = useMutation({
    mutationFn: () => api<{ ok: true }>('/auth/reset-password', { method: 'POST', body: { token, password } }),
  });
  const mismatch = confirm.length > 0 && confirm !== password;

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 to-slate-100 px-4 py-6">
      <div className="mx-auto max-w-md">
        <div className="mb-6 flex items-center justify-between">
          <Link to="/" className="text-2xl font-bold text-brand-700">Lugali</Link>
          <LanguageSwitch />
        </div>
        <div className="card">
          <h1 className="mb-4 text-xl font-semibold">{t('auth.resetTitle')}</h1>
          {!token ? (
            <p className="text-sm text-slate-600">{t('auth.invalid_reset_token')}</p>
          ) : reset.isSuccess ? (
            <div className="space-y-4">
              <p className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">{t('auth.resetDone')}</p>
              <Link to="/?login=1" className="btn-primary block w-full text-center">{t('auth.login')}</Link>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (!mismatch) reset.mutate();
              }}
            >
              <div>
                <label className="label" htmlFor="new-pass">{t('auth.newPassword')}</label>
                <input id="new-pass" type="password" required minLength={8} autoFocus autoComplete="new-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
                <p className="mt-1 text-xs text-slate-500">{t('auth.passwordHint')}</p>
              </div>
              <div>
                <label className="label" htmlFor="new-pass2">{t('auth.confirmPassword')}</label>
                <input id="new-pass2" type="password" required minLength={8} autoComplete="new-password" className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                {mismatch && <p className="mt-1 text-xs text-rose-600">{t('auth.passwordMismatch')}</p>}
              </div>
              <ErrorText error={reset.error} ns="auth" />
              <button type="submit" className="btn-primary w-full" disabled={reset.isPending || mismatch}>
                {reset.isPending ? t('common.loading') : t('auth.resetSave')}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
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
    name: googleSignup.get()?.name ?? '',
    phone: '',
    email: '',
    password: '',
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  // Signed in with Google: email from Google, no password to make up.
  const [g, setG] = useState(googleSignup.get);
  const takeGoogle = (credential: string) => {
    const b64 = credential.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { email?: string; name?: string };
    const v = { credential, email: payload.email ?? '', name: payload.name ?? null };
    googleSignup.set(v);
    setG(v);
    setForm((f) => ({ ...f, name: f.name || v.name || '' }));
  };

  const register = useMutation({
    mutationFn: () =>
      api<AuthResponse>('/auth/register', {
        method: 'POST',
        body: {
          ...form,
          ...(g ? { email: g.email, password: undefined, googleCredential: g.credential, name: form.name || g.name || '' } : {}),
          phone: form.phone || undefined,
          plan,
          locale: i18n.language.startsWith('en') ? 'en' : 'es',
        },
      }),
    onSuccess: (res) => {
      googleSignup.clear();
      setSession(res);
      navigate('/services');
    },
  });

  if (user) return <Navigate to="/agenda" replace />;

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 to-slate-100 px-4 py-6">
      <div className={`mx-auto ${plan ? 'max-w-md' : 'max-w-5xl'}`}>
        <div className="mb-6 flex items-center justify-between">
          <Link to="/" className="text-2xl font-bold text-brand-700">Lugali</Link>
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
                <span className="label">{t('auth.businessType')}</span>
                <BusinessTypePicker id="r-type" value={form.businessType} onChange={(b) => setForm((f) => ({ ...f, businessType: b }))} />
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
              {g ? (
                <p className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 p-3 text-sm" data-testid="google-signup">
                  <span>✓ {t('auth.withGoogle', { email: g.email })}</span>
                  <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => { googleSignup.clear(); setG(null); }}>{t('plans.change')}</button>
                </p>
              ) : (
                <>
                  <GoogleButton text="signup_with" onCredential={takeGoogle} />
                  <div>
                    <label className="label" htmlFor="r-email">{t('auth.email')}</label>
                    <input id="r-email" type="email" required autoComplete="email" className="input" value={form.email} onChange={set('email')} />
                  </div>
                  <div>
                    <label className="label" htmlFor="r-pass">{t('auth.password')}</label>
                    <input id="r-pass" type="password" required minLength={8} autoComplete="new-password" className="input" value={form.password} onChange={set('password')} />
                    <p className="mt-1 text-xs text-slate-500">{t('auth.passwordHint')}</p>
                  </div>
                </>
              )}
              {plan !== 'free' && <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">{t('plans.billingSoon')}</p>}
              <ErrorText error={register.error} ns="auth" />
              <button className="btn-primary w-full" disabled={register.isPending}>
                {register.isPending ? t('common.loading') : t('auth.register')}
              </button>
              <AcceptLegal />
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
