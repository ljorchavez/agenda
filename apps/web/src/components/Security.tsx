import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import type { SessionUser, TotpSetupDto } from '@agenda/shared';
import { api, downloadFile } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ErrorText, Modal } from './ui';

/** Two-step sign-in with an authenticator app (Google Authenticator, Microsoft, 1Password…). */
export function TwoFactorSection() {
  const { t } = useTranslation();
  const { user, setUser } = useAuth();
  const [setup, setSetup] = useState<TotpSetupDto | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (!setup) return setQr(null);
    void QRCode.toDataURL(setup.otpauthUrl, { margin: 1, width: 200 }).then(setQr).catch(() => setQr(null));
  }, [setup]);

  const start = useMutation({
    mutationFn: () => api<TotpSetupDto>('/auth/2fa/setup', { method: 'POST' }),
    onSuccess: (s) => {
      setSetup(s);
      setCode('');
    },
  });
  const enable = useMutation({
    mutationFn: () => api<{ recoveryCodes: string[] }>('/auth/2fa/enable', { method: 'POST', body: { code } }),
    onSuccess: (r) => {
      setRecovery(r.recoveryCodes);
      setSetup(null);
      if (user) setUser({ ...user, twoFactor: true } as SessionUser);
    },
  });
  const disable = useMutation({
    mutationFn: () => api<{ ok: true }>('/auth/2fa/disable', { method: 'POST', body: { password, code } }),
    onSuccess: () => {
      setDisabling(false);
      setPassword('');
      setCode('');
      if (user) setUser({ ...user, twoFactor: false } as SessionUser);
    },
  });

  return (
    <div className="space-y-3 border-t border-slate-200 pt-4" data-testid="two-factor">
      <h3 className="font-semibold">{t('mfa.title')}</h3>
      {user?.twoFactor ? (
        <>
          <p className="text-sm text-emerald-700">✓ {t('mfa.on')}</p>
          {!disabling ? (
            <button type="button" className="btn-secondary" onClick={() => setDisabling(true)}>{t('mfa.turnOff')}</button>
          ) : (
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); disable.mutate(); }}>
              <input type="password" required autoComplete="current-password" className="input" placeholder={t('settings.currentPassword')} value={password} onChange={(e) => setPassword(e.target.value)} />
              <input required inputMode="numeric" autoComplete="one-time-code" className="input" placeholder={t('mfa.code')} value={code} onChange={(e) => setCode(e.target.value)} />
              <ErrorText error={disable.error} ns="auth" />
              <div className="flex gap-2">
                <button className="btn-danger" disabled={disable.isPending}>{t('mfa.turnOff')}</button>
                <button type="button" className="btn-secondary" onClick={() => setDisabling(false)}>{t('common.cancel')}</button>
              </div>
            </form>
          )}
        </>
      ) : setup ? (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); enable.mutate(); }}>
          <p className="text-sm text-slate-600">{t('mfa.scan')}</p>
          {qr && <img src={qr} alt="QR" className="mx-auto h-48 w-48" data-testid="mfa-qr" />}
          <a href={setup.otpauthUrl} className="block text-center text-sm font-medium text-brand-700 hover:underline md:hidden">{t('mfa.openApp')}</a>
          <p className="text-xs text-slate-500">
            {t('mfa.manual')} <code className="select-all break-all rounded bg-slate-100 px-1" data-testid="mfa-secret">{setup.secret}</code>
          </p>
          <label className="label" htmlFor="mfa-enable-code">{t('mfa.code')}</label>
          <input id="mfa-enable-code" required inputMode="numeric" pattern="\d{6}" autoComplete="one-time-code" className="input text-center tracking-widest" value={code} onChange={(e) => setCode(e.target.value)} />
          <ErrorText error={enable.error} ns="auth" />
          <div className="flex gap-2">
            <button className="btn-primary" disabled={enable.isPending}>{t('mfa.turnOn')}</button>
            <button type="button" className="btn-secondary" onClick={() => setSetup(null)}>{t('common.cancel')}</button>
          </div>
        </form>
      ) : (
        <>
          <p className="text-sm text-slate-600">{t('mfa.why')}</p>
          <button type="button" className="btn-secondary" disabled={start.isPending} onClick={() => start.mutate()} data-testid="mfa-start">{t('mfa.setUp')}</button>
          <ErrorText error={start.error} ns="auth" />
        </>
      )}
      {recovery && (
        <Modal open title={t('mfa.recoveryTitle')} onClose={() => setRecovery(null)}>
          <p className="mb-3 text-sm text-slate-600">{t('mfa.recoveryHelp')}</p>
          <ul className="grid grid-cols-2 gap-2 font-mono text-sm" data-testid="mfa-recovery">
            {recovery.map((c) => <li key={c} className="rounded bg-slate-100 px-2 py-1 text-center">{c}</li>)}
          </ul>
          <div className="mt-4 flex gap-2">
            <button type="button" className="btn-secondary" onClick={() => void navigator.clipboard?.writeText(recovery.join('\n'))}>{t('mfa.copy')}</button>
            <button type="button" className="btn-primary" onClick={() => setRecovery(null)}>{t('mfa.saved')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Owner: download all the business's data, or delete the business for good. */
export function BusinessDataSection() {
  const { t } = useTranslation();
  const { tenant, logout, businesses, switchBusiness } = useAuth();
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [password, setPassword] = useState('');
  const exp = useMutation({
    mutationFn: () => downloadFile('/tenant/export', `lugali-${tenant?.slug ?? 'negocio'}-${new Date().toISOString().slice(0, 10)}.json`),
  });
  const del = useMutation({
    mutationFn: () => api<{ ok: true; otherBusinesses: number }>('/tenant/delete', { method: 'POST', body: { password, confirmName } }),
    onSuccess: async () => {
      const other = businesses.find((b) => b.id !== tenant?.id);
      if (other) {
        await switchBusiness(other.id);
        navigate('/agenda');
      } else {
        logout();
        navigate('/');
      }
    },
  });
  return (
    <section className="card mt-6 space-y-3" data-testid="business-data">
      <h2 className="font-semibold">{t('data.title')}</h2>
      <p className="text-sm text-slate-600">{t('data.exportHelp')}</p>
      <button type="button" className="btn-secondary" disabled={exp.isPending} onClick={() => exp.mutate()} data-testid="export-data">
        {exp.isPending ? t('common.loading') : t('data.export')}
      </button>
      <ErrorText error={exp.error} />
      <hr className="border-slate-200" />
      <p className="text-sm text-slate-600">{t('data.deleteHelp')}</p>
      <button type="button" className="btn-danger" onClick={() => setDeleting(true)} data-testid="delete-business">{t('data.delete')}</button>
      {deleting && (
        <Modal open title={t('data.deleteTitle', { name: tenant?.name })} onClose={() => setDeleting(false)}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); del.mutate(); }}>
            <p className="text-sm text-rose-800">{t('data.deleteWarning')}</p>
            <div>
              <label className="label" htmlFor="del-name">{t('data.typeName', { name: tenant?.name })}</label>
              <input id="del-name" required className="input" autoComplete="off" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="del-pass">{t('settings.currentPassword')}</label>
              <input id="del-pass" type="password" required autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <ErrorText error={del.error} ns="settings" />
            <div className="flex gap-2">
              <button className="btn-danger" disabled={del.isPending || confirmName.trim().toLowerCase() !== (tenant?.name ?? '').trim().toLowerCase()}>{t('data.deleteForGood')}</button>
              <button type="button" className="btn-secondary" onClick={() => setDeleting(false)}>{t('common.cancel')}</button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
