import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeDepositCents, DEFAULT_PAYMENT_SETTINGS, isValidClabe, normalizeMxPhone } from '@agenda/shared';
import { decryptSecret, encryptSecret } from '../src/lib/crypto.js';
import { signToken, slugify, verifyToken } from '../src/lib/auth.js';
import { verifyMercadoPagoSignature } from '../src/integrations/mercadopago.js';

describe('slugify', () => {
  it('removes accents and spaces', () => {
    expect(slugify('Clínica Nutrición Sana')).toBe('clinica-nutricion-sana');
    expect(slugify('  Barbería   El Güero!! ')).toBe('barberia-el-guero');
  });
});

describe('normalizeMxPhone', () => {
  it('normalizes common Mexican formats to E.164', () => {
    expect(normalizeMxPhone('55 1234 5678')).toBe('+525512345678');
    expect(normalizeMxPhone('525512345678')).toBe('+525512345678');
    expect(normalizeMxPhone('5215512345678')).toBe('+525512345678');
    expect(normalizeMxPhone('+1 415 555 0100')).toBe('+14155550100');
  });
});

describe('JWT', () => {
  it('round-trips claims', async () => {
    const token = await signToken({ sub: 'u1', tid: 't1', role: 'owner' });
    await expect(verifyToken(token)).resolves.toEqual({ sub: 'u1', tid: 't1', role: 'owner' });
  });
  it('rejects tampered tokens', async () => {
    const token = await signToken({ sub: 'u1', tid: 't1', role: 'owner' });
    await expect(verifyToken(token.slice(0, -2) + 'xx')).rejects.toThrow();
  });
});

describe('Mercado Pago webhook signature', () => {
  it('accepts a valid signature and rejects a wrong one', () => {
    process.env.MERCADOPAGO_WEBHOOK_SECRET = 'whsec';
    const ts = '1700000000';
    const manifest = `id:123;request-id:req-1;ts:${ts};`;
    const v1 = crypto.createHmac('sha256', 'whsec').update(manifest).digest('hex');
    expect(
      verifyMercadoPagoSignature({ signature: `ts=${ts},v1=${v1}`, requestId: 'req-1', dataId: '123' }),
    ).toBe(true);
    expect(
      verifyMercadoPagoSignature({ signature: `ts=${ts},v1=${'0'.repeat(64)}`, requestId: 'req-1', dataId: '123' }),
    ).toBe(false);
    delete process.env.MERCADOPAGO_WEBHOOK_SECRET;
  });
});

describe('payments helpers', () => {
  it('validates CLABE check digit', () => {
    expect(isValidClabe('012180001234567899')).toBe(true);
    expect(isValidClabe('012180001234567890')).toBe(false);
    expect(isValidClabe('123')).toBe(false);
  });
  it('computes deposits', () => {
    const pct = { ...DEFAULT_PAYMENT_SETTINGS, deposit: { enabled: true, type: 'percent' as const, value: 30 } };
    const fixed = { ...DEFAULT_PAYMENT_SETTINGS, deposit: { enabled: true, type: 'fixed' as const, value: 20000 } };
    expect(computeDepositCents(70000, pct)).toBe(21000);
    expect(computeDepositCents(70000, fixed)).toBe(20000);
    expect(computeDepositCents(15000, fixed)).toBe(15000); // never above price
    expect(computeDepositCents(70000, DEFAULT_PAYMENT_SETTINGS)).toBe(0); // off by default
    expect(computeDepositCents(70000, undefined)).toBe(0);
  });
  it('encrypts secrets reversibly and non-deterministically', () => {
    const a = encryptSecret('APP_USR-secret');
    expect(a).not.toContain('secret');
    expect(a).not.toBe(encryptSecret('APP_USR-secret'));
    expect(decryptSecret(a)).toBe('APP_USR-secret');
  });
});
