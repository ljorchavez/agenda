import type { Context } from 'hono';
import { AppError } from './errors.js';
import { clientIp } from './throttle.js';

/**
 * Cloudflare Turnstile (free, usually invisible) on sign-up and public forms, against bots.
 * Off until TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY are set. The browser sends the token in
 * the `X-Captcha-Token` header.
 */
export const turnstileSiteKey = () => process.env.TURNSTILE_SITE_KEY?.trim() || null;
const secretKey = () => process.env.TURNSTILE_SECRET_KEY?.trim() || null;

type Fetch = typeof fetch;
let fetchImpl: Fetch = (...a) => fetch(...a);
export const setCaptchaFetch = (f: Fetch | null) => {
  fetchImpl = f ?? ((...a) => fetch(...a));
};

export async function assertCaptcha(c: Context): Promise<void> {
  const secret = secretKey();
  if (!secret || !turnstileSiteKey()) return;
  const token = c.req.header('x-captcha-token');
  if (!token) throw new AppError(422, 'captcha_required', 'Complete the anti-bot check');
  try {
    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: clientIp(c) }),
    });
    const json = (await res.json()) as { success?: boolean };
    if (json.success) return;
  } catch (e) {
    // Cloudflare down: don't lock everyone out of booking.
    console.warn('[captcha] verify failed, letting it through:', e);
    return;
  }
  throw new AppError(422, 'captcha_failed', 'The anti-bot check failed; try again');
}
