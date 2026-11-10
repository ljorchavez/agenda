import type { ApiErrorBody } from '@agenda/shared';

const TOKEN_KEY = 'agenda.token';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
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

/** Fetch wrapper: JSON in/out, bearer token, typed errors. Base URL is same-origin /api. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = tokenStore.get();
  // FormData (file uploads) goes as-is so the browser sets the multipart boundary.
  const form = init.body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: init.body === undefined ? undefined : form ? (init.body as FormData) : JSON.stringify(init.body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as T & ApiErrorBody;
  if (!res.ok) {
    if (res.status === 401 && token) {
      tokenStore.clear();
      window.location.assign('/?login=1');
    }
    throw new ApiError(res.status, data.error ?? 'error', data.message, data.details);
  }
  return data;
}
