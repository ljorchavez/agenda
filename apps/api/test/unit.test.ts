import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeDepositCents, DEFAULT_PAYMENT_SETTINGS, isValidClabe, normalizeMxPhone } from '@agenda/shared';
import { decryptSecret, encryptSecret, manageToken, verifyManageToken } from '../src/lib/crypto.js';
import { DateTime } from 'luxon';
import { defaultGranularity, previousRange } from '../src/routes/reports.js';
import { policy } from '../src/routes/manage.js';
import { pickTable } from '../src/lib/tables.js';
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

describe('manage link token', () => {
  it('verifies only authentic tokens', () => {
    const id = '0b9f3a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
    const tok = manageToken(id);
    expect(verifyManageToken(tok)).toBe(id);
    expect(verifyManageToken(tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A'))).toBeNull();
    expect(verifyManageToken(manageToken(id).replace(id, '1b9f3a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b'))).toBeNull();
    expect(verifyManageToken('garbage')).toBeNull();
  });
});

describe('reports ranges', () => {
  const tz = 'America/Mexico_City';
  const d = (s: string) => DateTime.fromISO(s, { zone: tz });
  it('compares whole months with the same number of previous months', () => {
    const p = previousRange({ start: d('2026-03-01'), end: d('2026-04-01') });
    expect(p.start.toISODate()).toBe('2026-02-01');
    expect(p.end.toISODate()).toBe('2026-03-01');
    const q = previousRange({ start: d('2026-01-01'), end: d('2027-01-01') });
    expect(q.start.toISODate()).toBe('2025-01-01');
  });
  it('compares arbitrary ranges with the same number of days', () => {
    const p = previousRange({ start: d('2026-03-10'), end: d('2026-03-17') });
    expect(p.start.toISODate()).toBe('2026-03-03');
    expect(p.end.toISODate()).toBe('2026-03-10');
  });
  it('picks a sensible default granularity', () => {
    expect(defaultGranularity(7)).toBe('day');
    expect(defaultGranularity(90)).toBe('week');
    expect(defaultGranularity(365)).toBe('month');
  });
});

describe('self-service policy', () => {
  const settings = { selfService: { rescheduleEnabled: true, cancelEnabled: false, minHoursNotice: 24 } } as never;
  const now = DateTime.fromISO('2026-05-10T10:00:00Z');
  it('allows changes before the deadline only', () => {
    const ok = policy({ status: 'scheduled', startsAt: new Date('2026-05-12T10:00:00Z') }, { settings }, now);
    expect(ok.canReschedule).toBe(true);
    expect(ok.canCancel).toBe(false);
    const late = policy({ status: 'confirmed', startsAt: new Date('2026-05-11T09:00:00Z') }, { settings }, now);
    expect(late.reason).toBe('too_late');
    expect(late.canReschedule).toBe(false);
    const done = policy({ status: 'completed', startsAt: new Date('2026-05-12T10:00:00Z') }, { settings }, now);
    expect(done.reason).toBe('not_active');
  });
});

describe('restaurant table assignment', () => {
  const tables = [
    { id: 't4', name: 'Mesa 4', seats: 4 },
    { id: 't2', name: 'Mesa 2', seats: 2 },
    { id: 't10', name: 'Mesa 10', seats: 2 },
    { id: 't6', name: 'Mesa 6', seats: 6 },
  ];
  const at = (h: number) => new Date(Date.UTC(2026, 4, 10, h));
  it('picks the smallest table that fits, by natural name order', () => {
    expect(pickTable(tables, [], 2, at(20), at(21))?.id).toBe('t2');
    expect(pickTable(tables, [], 3, at(20), at(21))?.id).toBe('t4');
    expect(pickTable(tables, [], 7, at(20), at(21))).toBeNull();
  });
  it('skips busy tables and frees them after the reservation ends', () => {
    const busy = [
      { tableId: 't2', s: at(19), e: at(21) },
      { tableId: 't10', s: at(20), e: at(22) },
    ];
    expect(pickTable(tables, busy, 2, at(20), at(21))?.id).toBe('t4');
    expect(pickTable(tables, busy, 2, at(21), at(22))?.id).toBe('t2');
  });
});
