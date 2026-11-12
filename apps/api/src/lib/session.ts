import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { SESSION_DAYS } from './auth.js';

/**
 * The staff session lives in an HttpOnly cookie, so scripts on the page can't read it.
 * Requests that change data with this cookie must also send `X-Requested-With` (the app's
 * fetch wrapper does): a page on another site can't add that header without our CORS allowing it.
 */
export const SESSION_COOKIE = 'lugali_session';
export const CSRF_HEADER = 'x-requested-with';

const isHttps = (c: Context) =>
  c.req.header('x-forwarded-proto') === 'https' || new URL(c.req.url).protocol === 'https:';

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: SESSION_DAYS * 86400,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isHttps(c) });
}

export const sessionCookie = (c: Context) => getCookie(c, SESSION_COOKIE);
