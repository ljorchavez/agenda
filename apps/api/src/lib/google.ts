import { AppError } from './errors.js';

/**
 * "Continuar con Google": checks a Google Identity Services ID token with Google's tokeninfo
 * endpoint (signature, expiry) and that it was issued for our app (GOOGLE_CLIENT_ID).
 * Free: needs only an OAuth client ID from Google Cloud, no secret.
 */
export interface GoogleProfile {
  email: string;
  name: string | null;
}
type Verifier = (credential: string) => Promise<GoogleProfile>;

export const googleClientId = () => process.env.GOOGLE_CLIENT_ID?.trim() || null;

const viaTokenInfo: Verifier = async (credential) => {
  const clientId = googleClientId();
  if (!clientId) throw new AppError(422, 'google_not_configured', 'Google sign-in is not set up');
  let res: Response;
  try {
    res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
  } catch {
    throw new AppError(502, 'google_unreachable', 'Could not reach Google');
  }
  if (!res.ok) throw new AppError(401, 'google_invalid', 'Invalid Google sign-in');
  const t = (await res.json()) as { aud?: string; iss?: string; email?: string; email_verified?: string | boolean; name?: string; exp?: string };
  const verified = t.email_verified === true || t.email_verified === 'true';
  const issuer = t.iss === 'accounts.google.com' || t.iss === 'https://accounts.google.com';
  if (t.aud !== clientId || !issuer || !verified || !t.email || Number(t.exp ?? 0) * 1000 < Date.now()) {
    throw new AppError(401, 'google_invalid', 'Invalid Google sign-in');
  }
  return { email: t.email.toLowerCase(), name: t.name ?? null };
};

let verifier: Verifier = viaTokenInfo;
export const verifyGoogleCredential = (credential: string) => verifier(credential);
/** Tests only: replace Google's check. */
export function setGoogleVerifier(fn: Verifier | null) {
  verifier = fn ?? viaTokenInfo;
}
