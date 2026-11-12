import crypto from 'node:crypto';

/**
 * Two-step sign-in with an authenticator app (RFC 6238 TOTP: SHA-1, 6 digits, 30 seconds),
 * the same codes Google Authenticator, Microsoft Authenticator or 1Password show.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0xf;
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!;
  return String(bin % 1_000_000).padStart(6, '0');
}

export const totpStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

/** Code for a step (tests and the setup screen use it). */
export const totpCode = (secretB32: string, step = totpStep()) => hotp(base32Decode(secretB32), step);

/**
 * Checks a 6-digit code allowing one step of clock drift either way. Returns the matching step
 * (store it so the same code can't be replayed) or null. Steps at or before `lastStep` fail.
 */
export function verifyTotp(secretB32: string, code: string, lastStep: number | null, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const current = totpStep(now);
  for (const step of [current - 1, current, current + 1]) {
    if (lastStep != null && step <= lastStep) continue;
    const expected = Buffer.from(hotp(secret, step));
    if (crypto.timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUrl(secretB32: string, account: string, issuer = 'Lugali'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

// ---------- Recovery codes ----------

const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** "xxxx-xxxx" codes for when the phone is lost; each works once. */
export function generateRecoveryCodes(n = 8): string[] {
  return Array.from({ length: n }, () => {
    const bytes = crypto.randomBytes(8);
    const s = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export const normalizeRecovery = (code: string) => code.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
export const hashRecovery = (code: string) => crypto.createHash('sha256').update(`lugali-recovery:${normalizeRecovery(code)}`).digest('hex');
