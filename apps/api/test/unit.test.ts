import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeMxPhone } from '@agenda/shared';
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
