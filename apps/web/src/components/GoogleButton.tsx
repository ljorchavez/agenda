import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { PublicConfigDto } from '@agenda/shared';
import { api } from '../lib/api';

type Gis = {
  accounts: {
    id: {
      initialize: (o: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: string }) => void;
      renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
    };
  };
};
declare global {
  interface Window {
    google?: Gis;
  }
}

let loading: Promise<void> | null = null;
const loadGis = () =>
  (loading ??= new Promise<void>((resolve, reject) => {
    if (window.google?.accounts) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('gis'));
    };
    document.head.appendChild(s);
  }));

export const usePublicConfig = () =>
  useQuery({ queryKey: ['public-config'], queryFn: () => api<PublicConfigDto>('/config'), staleTime: Infinity, retry: false });

/** "Continuar con Google" (Google Identity Services). Hidden until GOOGLE_CLIENT_ID is set. */
export function GoogleButton({ onCredential, text = 'continue_with' }: { onCredential: (credential: string) => void; text?: 'continue_with' | 'signup_with' }) {
  const { i18n } = useTranslation();
  const cfg = usePublicConfig();
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onCredential);
  cb.current = onCredential;
  const clientId = cfg.data?.googleClientId;
  useEffect(() => {
    if (!clientId || !ref.current) return;
    let alive = true;
    void loadGis()
      .then(() => {
        if (!alive || !ref.current || !window.google) return;
        window.google.accounts.id.initialize({ client_id: clientId, callback: (r) => cb.current(r.credential) });
        window.google.accounts.id.renderButton(ref.current, {
          theme: 'outline',
          size: 'large',
          shape: 'pill',
          text,
          width: Math.min(360, ref.current.offsetWidth || 320),
          locale: i18n.language.startsWith('en') ? 'en' : 'es-419',
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [clientId, text, i18n.language]);
  if (!clientId) return null;
  return <div ref={ref} className="flex min-h-11 justify-center" data-testid="google-button" />;
}

const KEY = 'agenda.googleSignup';
/** Google data carried from the login window to sign-up (this tab only). */
export const googleSignup = {
  set: (v: { credential: string; email: string; name: string | null }) => sessionStorage.setItem(KEY, JSON.stringify(v)),
  get: (): { credential: string; email: string; name: string | null } | null => {
    try {
      return JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    } catch {
      return null;
    }
  },
  clear: () => sessionStorage.removeItem(KEY),
};
