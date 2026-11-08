import crypto from 'node:crypto';

/**
 * Symmetric encryption for secrets stored in the DB (e.g. each business's Mercado Pago token).
 * Key: DATA_ENCRYPTION_KEY if set, otherwise derived from JWT_SECRET.
 * Format: base64(iv[12] | tag[16] | ciphertext)
 */
function key(): Buffer {
  const material = process.env.DATA_ENCRYPTION_KEY ?? process.env.JWT_SECRET;
  if (!material) throw new Error('DATA_ENCRYPTION_KEY or JWT_SECRET must be set');
  return crypto.createHash('sha256').update(`agenda-data-key:${material}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decryptSecret(payload: string): string {
  const buf = Buffer.from(payload, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
