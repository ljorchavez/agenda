import crypto from 'node:crypto';

/**
 * Symmetric encryption for data stored in the DB (clinical records, each business's keys).
 * AES-256-GCM, payload base64(iv[12] | tag[16] | ciphertext).
 *
 * - "v2:<payload>": key from DATA_ENCRYPTION_KEY (its own secret, so JWT_SECRET can be rotated
 *   to sign everyone out without losing data).
 * - "<payload>" (older rows): key derived from JWT_SECRET. Still readable; `db:reencrypt`
 *   rewrites them as v2 on deploy.
 */
const V2 = 'v2:';

function derive(material: string): Buffer {
  return crypto.createHash('sha256').update(`agenda-data-key:${material}`).digest();
}
function dataKey(): Buffer | null {
  const k = process.env.DATA_ENCRYPTION_KEY?.trim();
  return k ? derive(k) : null;
}
function legacyKey(): Buffer {
  const material = process.env.JWT_SECRET;
  if (!material) throw new Error('JWT_SECRET must be set');
  return derive(material);
}

function seal(plain: string, key: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}
function open(payload: string, key: Buffer): string {
  const buf = Buffer.from(payload, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export function encryptSecret(plain: string): string {
  const k = dataKey();
  return k ? V2 + seal(plain, k) : seal(plain, legacyKey());
}

export function decryptSecret(payload: string): string {
  if (payload.startsWith(V2)) {
    const k = dataKey();
    if (!k) throw new Error('DATA_ENCRYPTION_KEY is needed to read this data');
    return open(payload.slice(V2.length), k);
  }
  return open(payload, legacyKey());
}

/** Encrypted with the old JWT_SECRET-derived key (and a data key is available to move it). */
export const needsReencrypt = (payload: string) => !payload.startsWith(V2) && dataKey() !== null;

/**
 * Signed, unguessable token for a customer's "manage my appointment" link (/c/<token>).
 * Stateless: <appointmentId>.<hmac>. Changing JWT_SECRET invalidates old links.
 */
function manageKey(): Buffer {
  const material = process.env.JWT_SECRET;
  if (!material) throw new Error('JWT_SECRET must be set');
  return crypto.createHash('sha256').update(`agenda-manage-key:${material}`).digest();
}

function manageSig(appointmentId: string): string {
  return crypto.createHmac('sha256', manageKey()).update(appointmentId).digest('base64url').slice(0, 24);
}

export function manageToken(appointmentId: string): string {
  return `${appointmentId}.${manageSig(appointmentId)}`;
}

/** Private link to an online purchase (/compra/<token>): <paymentId>.<hmac of "purchase:id">. */
export function purchaseToken(paymentId: string): string {
  return `${paymentId}.${manageSig(`purchase:${paymentId}`)}`;
}
export function verifyPurchaseToken(token: string): string | null {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{24})$/.exec(token);
  if (!m) return null;
  const expected = Buffer.from(manageSig(`purchase:${m[1]!}`));
  const given = Buffer.from(m[2]!);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? m[1]! : null;
}

/** Returns the appointment id if the token is authentic, otherwise null. */
export function verifyManageToken(token: string): string | null {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{24})$/.exec(token);
  if (!m) return null;
  const expected = Buffer.from(manageSig(m[1]!));
  const given = Buffer.from(m[2]!);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? m[1]! : null;
}

/** Public link to verify a signed prescription (/receta/<token>): <noteId>.<hmac of "rx:id">. */
export function prescriptionToken(noteId: string): string {
  return `${noteId}.${manageSig(`rx:${noteId}`)}`;
}
export function verifyPrescriptionToken(token: string): string | null {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{24})$/.exec(token);
  if (!m) return null;
  const expected = Buffer.from(manageSig(`rx:${m[1]!}`));
  const given = Buffer.from(m[2]!);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? m[1]! : null;
}

/**
 * Patient portal session (/p/<slug>?t=<token>): <customerId>.<expires>.<hmac>. Valid 90 days and
 * renewed on each visit, so a patient who comes back stays signed in on their phone. Every
 * confirmation and reminder email carries a fresh one too.
 */
export const PORTAL_DAYS = 90;
export function portalToken(customerId: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + PORTAL_DAYS * 86400;
  return `${customerId}.${exp}.${manageSig(`portal:${customerId}:${exp}`)}`;
}
export function verifyPortalToken(token: string | null | undefined, now = Date.now()): string | null {
  const m = /^([0-9a-f-]{36})\.(\d{10})\.([A-Za-z0-9_-]{24})$/.exec(token ?? '');
  if (!m) return null;
  if (Number(m[2]) * 1000 < now) return null;
  const expected = Buffer.from(manageSig(`portal:${m[1]!}:${m[2]!}`));
  const given = Buffer.from(m[3]!);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? m[1]! : null;
}

/** Expiry (ms) of a portal token, or null. */
export function portalTokenExpiry(token: string | null | undefined): number | null {
  const m = /^[0-9a-f-]{36}\.(\d{10})\./.exec(token ?? '');
  return m ? Number(m[1]) * 1000 : null;
}

/**
 * 6-digit sign-in code for the portal (sent with the link, for when the email opens on another
 * device). Stateless: derived from the customer and a 10-minute window; the current and the
 * previous window are accepted, so a code lasts 10-20 minutes.
 */
const CODE_WINDOW_MS = 10 * 60 * 1000;
function codeFor(customerId: string, window: number): string {
  const h = crypto.createHmac('sha256', manageKey()).update(`portal-code:${customerId}:${window}`).digest();
  return String(h.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}
export function portalCode(customerId: string, now = Date.now()): string {
  return codeFor(customerId, Math.floor(now / CODE_WINDOW_MS));
}
export function verifyPortalCode(customerId: string, code: string, now = Date.now()): boolean {
  const w = Math.floor(now / CODE_WINDOW_MS);
  const given = Buffer.from(code.trim());
  return [w, w - 1].some((x) => {
    const expected = Buffer.from(codeFor(customerId, x));
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
}
