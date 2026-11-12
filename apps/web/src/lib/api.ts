import type { ApiErrorBody } from '@agenda/shared';

/**
 * The session lives in an HttpOnly cookie the browser sends by itself; scripts never see it.
 * The app only keeps a "signed in" hint so public pages don't ask the API who you are.
 */
const HINT_KEY = 'agenda.session';
/** Before the cookie, the token itself was kept here; moved to the cookie on first load. */
const LEGACY_TOKEN_KEY = 'agenda.token';

const safeStorage = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
  remove(k: string) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* private mode */
    }
  },
};

export const sessionHint = {
  /** A session was opened in this browser (the cookie may still have expired) */
  get: () => safeStorage.get(HINT_KEY) === '1' || Boolean(safeStorage.get(LEGACY_TOKEN_KEY)),
  set: () => safeStorage.set(HINT_KEY, '1'),
  clear: () => {
    safeStorage.remove(HINT_KEY);
    safeStorage.remove(LEGACY_TOKEN_KEY);
  },
  /** Old token to hand over once to /auth/me, which moves it to the cookie */
  legacyToken: () => safeStorage.get(LEGACY_TOKEN_KEY),
  dropLegacy: () => safeStorage.remove(LEGACY_TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
    public details?: unknown,
  ) {
    super(message ?? code);
  }
}

/** Token from the anti-bot check (Turnstile) for the next request that needs it. */
let captchaToken: string | null = null;
let captchaReset: (() => void) | null = null;
export const setCaptchaToken = (t: string | null) => {
  captchaToken = t;
};
/** The widget registers how to get a fresh token (each token works once). */
export const onCaptchaReset = (fn: (() => void) | null) => {
  captchaReset = fn;
};

/** Paths where a 401 is an answer, not an expired session. */
const NO_REDIRECT = /^\/auth\/(login|google|register)/;

/** Fetch wrapper: JSON in/out, session cookie, typed errors. Base URL is same-origin /api. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const form = init.body instanceof FormData;
  const legacy = sessionHint.legacyToken();
  const usesCaptcha = Boolean(captchaToken && init.method && init.method !== 'GET');
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    headers: {
      // Lets the API tell our app from a form on another site (CSRF).
      'X-Requested-With': 'lugali',
      ...(init.body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}),
      ...(legacy ? { Authorization: `Bearer ${legacy}` } : {}),
      ...(usesCaptcha ? { 'X-Captcha-Token': captchaToken! } : {}),
    },
    // FormData (file uploads) goes as-is so the browser sets the multipart boundary.
    body: init.body === undefined ? undefined : form ? (init.body as FormData) : JSON.stringify(init.body),
  });
  if (usesCaptcha) {
    captchaToken = null;
    captchaReset?.();
  }
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!res.ok) {
    if (res.status === 401 && sessionHint.get() && !NO_REDIRECT.test(path)) {
      sessionHint.clear();
      window.location.assign('/?login=1');
    }
    throw new ApiError(res.status, data.error ?? 'error', data.message, data.details);
  }
  return data;
}

/** Downloads a private file (export, PDF) with the session and saves it. */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const res = await fetch(`/api${path}`, { credentials: 'same-origin', headers: { 'X-Requested-With': 'lugali' } });
  if (!res.ok) throw new ApiError(res.status, 'download_failed');
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
