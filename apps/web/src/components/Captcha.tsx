import { useEffect, useRef } from 'react';
import { onCaptchaReset, setCaptchaToken } from '../lib/api';
import { usePublicConfig } from './GoogleButton';

type Turnstile = {
  render: (el: HTMLElement, o: Record<string, unknown>) => string;
  remove: (id: string) => void;
  reset: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

let loading: Promise<void> | null = null;
const loadTurnstile = () =>
  (loading ??= new Promise<void>((resolve, reject) => {
    if (window.turnstile) return resolve();
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('turnstile'));
    };
    document.head.appendChild(s);
  }));

/**
 * Anti-bot check (Cloudflare Turnstile) for sign-up and public forms. Usually passes on its own
 * without the person doing anything. Hidden while TURNSTILE_SITE_KEY isn't configured.
 */
export function Captcha() {
  const cfg = usePublicConfig();
  const siteKey = cfg.data?.turnstileSiteKey;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!siteKey || !ref.current) return;
    let id: string | null = null;
    let alive = true;
    void loadTurnstile()
      .then(() => {
        if (!alive || !ref.current || !window.turnstile) return;
        id = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          appearance: 'interaction-only',
          callback: (t: string) => setCaptchaToken(t),
          'expired-callback': () => setCaptchaToken(null),
          'error-callback': () => setCaptchaToken(null),
        });
        onCaptchaReset(() => {
          if (id && window.turnstile) window.turnstile.reset(id);
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
      setCaptchaToken(null);
      onCaptchaReset(null);
      if (id && window.turnstile) window.turnstile.remove(id);
    };
  }, [siteKey]);
  if (!siteKey) return null;
  return <div ref={ref} className="flex justify-center" data-testid="captcha" />;
}
