import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
const DISMISS_KEY = 'agenda.installDismissed';

let deferred: InstallEvent | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallEvent;
  });
}

const standalone = () =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
const isPhone = () => window.matchMedia?.('(max-width: 767px)').matches;
const dismissed = () => {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
};

/** Registers the service worker (production builds only). */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

/** "Instala Agenda en tu celular": Android gets the install button, iPhone the two steps. */
export function InstallAppBanner() {
  const { t } = useTranslation();
  const [show, setShow] = useState(false);
  const [canPrompt, setCanPrompt] = useState(Boolean(deferred));
  useEffect(() => {
    if (standalone() || dismissed() || !isPhone()) return;
    setShow(true);
    const onPrompt = () => setCanPrompt(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  if (!show || (!canPrompt && !isIos())) return null;
  const close = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode */
    }
    setShow(false);
  };
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl border border-brand-100 bg-brand-50 p-3 text-sm text-brand-800" data-testid="install-app">
      <img src="/icons/icon-192.png" alt="" className="h-10 w-10 rounded-lg" />
      <div className="flex-1">
        <div className="font-medium">{t('install.title')}</div>
        {canPrompt ? (
          <button
            type="button"
            className="btn-primary mt-2 !py-1.5"
            onClick={async () => {
              await deferred?.prompt();
              deferred = null;
              close();
            }}
          >
            {t('install.button')}
          </button>
        ) : (
          <p className="text-xs">{t('install.ios')}</p>
        )}
      </div>
      <button type="button" aria-label={t('common.close')} className="text-brand-700" onClick={close}>✕</button>
    </div>
  );
}
