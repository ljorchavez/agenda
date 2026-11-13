import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bookingPriceCents, businessKind, computeDepositCents, DEFAULT_PAYMENT_SETTINGS, eligibleResources, hourlyPriceCents, isValidClabe, KIND_CONFIG, normalizeMxPhone, rentalSettingsOf } from '@agenda/shared';
import { decryptSecret, encryptSecret, manageToken, verifyManageToken } from '../src/lib/crypto.js';
import { DateTime } from 'luxon';
import { defaultGranularity, previousRange } from '../src/routes/reports.js';
import { policy } from '../src/routes/manage.js';
import { pickResource } from '../src/lib/resources.js';
import { signToken, slugify, verifyToken } from '../src/lib/auth.js';
import { verifyMercadoPagoSignature } from '../src/integrations/mercadopago.js';
import { whatsappAllowedFor } from '../src/integrations/whatsapp.js';
import { parseCsfText } from '../src/lib/csf.js';
import { readCsv, readXlsx, writeXlsx } from '@agenda/shared/xlsx';
import { strToU8, zipSync } from 'fflate';
import { planImport, toCentsCell, type Existing } from '../src/lib/product-import.js';

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
    const claims = await verifyToken(token);
    expect(claims).toMatchObject({ sub: 'u1', tid: 't1', role: 'owner' });
    expect(claims.iat).toBeCloseTo(Date.now() / 1000, -1);
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

describe('business kinds', () => {
  it('maps business types to how they book', () => {
    expect(businessKind('barbershop')).toBe('appointments');
    expect(businessKind('restaurant')).toBe('reservations');
    expect(businessKind('yoga')).toBe('classes');
    expect(businessKind('sports')).toBe('rentals');
    expect(rentalSettingsOf({}).durations).toEqual([60, 90, 120]);
    expect(rentalSettingsOf({ rentals: { durations: [120, 60] } }).durations).toEqual([60, 120]);
  });
});

// One assignment engine for every kind of business: people, courts and tables.
describe('pickResource', () => {
  const at = (h: number) => new Date(Date.UTC(2026, 0, 10, h));
  const pros = [
    { id: 'p1', name: 'Ana', serviceIds: [] as string[], capacity: null },
    { id: 'p2', name: 'Beto', serviceIds: ['s1'], capacity: null },
  ];
  const tables = [
    { id: 't4', name: 'Mesa 4', serviceIds: [] as string[], capacity: 4 },
    { id: 't2', name: 'Mesa 2', serviceIds: [] as string[], capacity: 2 },
    { id: 't10', name: 'Mesa 10', serviceIds: [] as string[], capacity: 2 },
    { id: 't6', name: 'Mesa 6', serviceIds: [] as string[], capacity: 6 },
  ];
  it('filters by service (empty list = all services) and by capacity (null = no limit)', () => {
    expect(eligibleResources(pros, { serviceId: 's1' }).map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(eligibleResources(pros, { serviceId: 's2' }).map((p) => p.id)).toEqual(['p1']);
    expect(eligibleResources(pros, { partySize: 8 }).map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(eligibleResources(tables, { partySize: 3 }).map((t) => t.id)).toEqual(['t4', 't6']);
  });
  it('picks a free person, spreading the load', () => {
    expect(pickResource(pros, [], at(10), at(11))?.id).toBe('p1');
    expect(pickResource(pros, [{ rid: 'p1', s: at(8), e: at(9) }], at(10), at(11))?.id).toBe('p2');
    expect(pickResource(pros, [{ rid: 'p1', s: at(10), e: at(11) }], at(10), at(11))?.id).toBe('p2');
    const both = [{ rid: 'p1', s: at(10), e: at(11) }, { rid: 'p2', s: at(10), e: at(12) }];
    expect(pickResource(pros, both, at(10), at(11))).toBeNull();
  });
  it('picks the smallest table that fits, by natural name order, and skips busy ones', () => {
    expect(pickResource(eligibleResources(tables, { partySize: 2 }), [], at(20), at(21))?.id).toBe('t2');
    expect(pickResource(eligibleResources(tables, { partySize: 3 }), [], at(20), at(21))?.id).toBe('t4');
    expect(pickResource(eligibleResources(tables, { partySize: 7 }), [], at(20), at(21))).toBeNull();
    const busy = [{ rid: 't2', s: at(19), e: at(21) }, { rid: 't10', s: at(20), e: at(22) }];
    expect(pickResource(eligibleResources(tables, { partySize: 2 }), busy, at(20), at(21))?.id).toBe('t4');
    expect(pickResource(eligibleResources(tables, { partySize: 2 }), busy, at(21), at(22))?.id).toBe('t2');
  });
  it('counts each booking without a resource as one resource taken', () => {
    const one = [{ rid: null, s: at(10), e: at(11) }];
    expect(pickResource(pros, one, at(10), at(11))?.id).toBe('p1');
    expect(pickResource(pros, [...one, { rid: null, s: at(10), e: at(11) }], at(10), at(11))).toBeNull();
    expect(pickResource([pros[0]!], one, at(10), at(11))).toBeNull();
  });
  it('prices by the hour when the resource has an hourly rate, else by service', () => {
    expect(hourlyPriceCents(40000, 90)).toBe(60000);
    expect(hourlyPriceCents(45000, 45)).toBe(33750);
    expect(bookingPriceCents({ pricePerHourCents: 40000 }, 25000, 60)).toBe(40000);
    expect(bookingPriceCents({ pricePerHourCents: null }, 25000, 60)).toBe(25000);
    expect(bookingPriceCents(null, 25000, 60)).toBe(25000);
  });
  it('keeps the per-kind differences in one config', () => {
    expect(KIND_CONFIG.reservations.partySize).toBe(true);
    expect(KIND_CONFIG.classes.sessions).toBe(true);
    expect(KIND_CONFIG.rentals.durations).toBe(true);
    expect(KIND_CONFIG.reservations.keepResourceOnReschedule).toBe(false);
  });
});

describe('whatsappAllowedFor', () => {
  it('demo businesses only message the test numbers', () => {
    const prev = process.env.WHATSAPP_TEST_TO;
    process.env.WHATSAPP_TEST_TO = '+523120000001, +525500000002';
    expect(whatsappAllowedFor('mi-negocio', '+523129999999')).toBe(true);
    expect(whatsappAllowedFor('medico-demo', '+523129999999')).toBe(false);
    expect(whatsappAllowedFor('medico-demo', '+5213120000001')).toBe(true);
    delete process.env.WHATSAPP_TEST_TO;
    expect(whatsappAllowedFor('medico-demo', '+523120000001')).toBe(false);
    if (prev !== undefined) process.env.WHATSAPP_TEST_TO = prev;
  });
});

describe('parseCsfText (Constancia de Situación Fiscal)', () => {
  it('reads a persona física with several regimes, the first one listed wins', () => {
    const text = `CÉDULA DE IDENTIFICACIÓN FISCAL CONSTANCIA DE SITUACIÓN FISCAL RFC: PELJ850312AB1 CURP: PELJ850312HCMRPN09
      Datos de Identificación del Contribuyente: RFC: PELJ850312AB1 CURP: PELJ850312HCMRPN09 Nombre (s): JUAN CARLOS
      Primer Apellido: PÉREZ Segundo Apellido: LÓPEZ Fecha inicio de operaciones: 01 DE ENERO DE 2010
      Estatus en el padrón: ACTIVO Fecha de último cambio de estado: 01 DE ENERO DE 2010 Nombre Comercial:
      Datos del domicilio registrado Código Postal:28017 Tipo de Vialidad: CALLE
      Regímenes: Régimen Fecha Inicio Fecha Fin Régimen Simplificado de Confianza 01/01/2022
      Régimen de Sueldos y Salarios e Ingresos Asimilados a Salarios 01/01/2010
      Obligaciones: Descripción de la Obligación Declaración anual de ISR. Sueldos y salarios`;
    const r = parseCsfText(text);
    expect(r.fiscal).toEqual({ rfc: 'PELJ850312AB1', legalName: 'JUAN CARLOS PÉREZ LÓPEZ', zip: '28017', taxSystem: '626' });
    expect(r.regimes).toEqual(['626', '605']);
    expect(r).toMatchObject({ personType: 'fisica', status: 'ACTIVO', warnings: [] });
  });

  it('reads a persona moral without the régimen capital', () => {
    const text = `CONSTANCIA DE SITUACIÓN FISCAL RFC: ABC120101XY9 Denominación/Razón Social: CAFÉ DEL PUERTO
      Régimen Capital: SOCIEDAD ANONIMA DE CAPITAL VARIABLE Nombre Comercial: CAFÉ DEL PUERTO
      Fecha inicio de operaciones: 01 DE ENERO DE 2012 Estatus en el padrón: SUSPENDIDO Fecha de último cambio
      Código Postal: 06600 Regímenes: Régimen General de Ley Personas Morales 01/01/2012 Obligaciones: ...`;
    const r = parseCsfText(text);
    expect(r.fiscal).toEqual({ rfc: 'ABC120101XY9', legalName: 'CAFÉ DEL PUERTO', zip: '06600', taxSystem: '601' });
    expect(r.personType).toBe('moral');
    expect(r.warnings).toEqual(['inactive']);
  });

  it('says so when there is nothing to read or it is another document', () => {
    expect(parseCsfText('').warnings).toEqual(['no_text']);
    const other = parseCsfText('Recibo de luz CFE, total a pagar 350 pesos, periodo septiembre');
    expect(other.warnings).toContain('not_csf');
    expect(other.warnings).toContain('missing_rfc');
  });
});

describe('xlsx', () => {
  it('writes and reads back text, numbers and booleans', () => {
    const rows = [['ID', 'Producto', 'Precio', 'Activo'], ['a1', 'Café & "pan" <ok>', 89.5, true], [null, 'Agua', 15, false]];
    expect(readXlsx(writeXlsx(rows, { sheet: 'Inventario' }))).toEqual(rows);
  });

  it('reads files saved by Excel (shared strings, gaps, rich text)', () => {
    const xml = (s: string) => strToU8(`<?xml version="1.0" encoding="UTF-8"?>${s}`);
    const file = zipSync({
      'xl/workbook.xml': xml('<workbook xmlns:r="r"><sheets><sheet name="Datos" sheetId="1" r:id="rId7"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': xml('<Relationships><Relationship Id="rId7" Type="x" Target="worksheets/hoja.xml"/></Relationships>'),
      'xl/sharedStrings.xml': xml('<sst><si><t>Producto</t></si><si><r><t>Gel </t></r><r><t>fijador</t></r></si><si><t>Precio</t></si></sst>'),
      'xl/worksheets/hoja.xml': xml('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row><row r="3"><c r="A3" t="s"><v>1</v></c><c r="C3"><v>90</v></c></row></sheetData></worksheet>'),
    });
    expect(readXlsx(file)).toEqual([['Producto', null, 'Precio'], [], ['Gel fijador', null, 90]]);
    expect(() => readXlsx(new Uint8Array([1, 2, 3]))).toThrow('not_xlsx');
  });

  it('reads CSV with commas or semicolons and quotes', () => {
    expect(readCsv('Producto,Precio\n"Gel, fijador",90\r\nAgua,15\n')).toEqual([['Producto', 'Precio'], ['Gel, fijador', '90'], ['Agua', '15']]);
    expect(readCsv('\uFEFFProducto;Precio\nPan;"1.234,50"')).toEqual([['Producto', 'Precio'], ['Pan', '1.234,50']]);
  });
});

describe('inventory import plan', () => {
  const gel: Existing = {
    id: '11111111-1111-4111-8111-111111111111',
    input: { name: 'Gel', sku: 'G1', category: 'Cabello', priceCents: 9000, costCents: 4000, trackStock: true, minStock: 2, iva: '16', satKey: null, requiresPrescription: false, active: true },
    stock: 5,
  };
  const existing = new Map([[gel.id, gel]]);

  it('reads money the way people type it', () => {
    expect([toCentsCell(90), toCentsCell('$1,234.50'), toCentsCell('1.234,50'), toCentsCell('12 MXN'), toCentsCell('abc'), toCentsCell(-1)]).toEqual([9000, 123450, 123450, 1200, null, null]);
  });

  it('updates by ID, creates without one, and reports errors per row', () => {
    const plan = planImport(
      [
        ['ID', 'Producto', 'Precio', 'Existencia', 'Costo', 'IVA', 'Clave SAT', 'Notas'],
        [gel.id, 'Gel fijador', '95', 8, null, '16%', null, 'x'],
        [null, 'Cera', 120, 3, 50, 'exento', 1010101, null],
        [null, null, null, null, null, null, null, null],
        [null, 'Sin precio', null, 1, null, null, null, null],
        ['22222222-2222-4222-8222-222222222222', 'Otro', 10, null, null, null, null, null],
        [null, 'Mal precio', 'diez', null, null, null, null, null],
      ],
      existing,
      { health: false },
    );
    expect(plan.ignored).toEqual(['Notas']);
    const [upd, cre, noPrice, unknown, bad] = plan.rows;
    expect(upd).toMatchObject({ row: 2, action: 'update', id: gel.id, stock: 8 });
    expect(upd!.changes.sort()).toEqual(['costCents', 'name', 'priceCents', 'stock']);
    expect(upd!.values).toMatchObject({ name: 'Gel fijador', priceCents: 9500, costCents: null, sku: 'G1', category: 'Cabello', minStock: 2 });
    expect(cre).toMatchObject({ row: 3, action: 'create', stock: 3, values: { name: 'Cera', priceCents: 12000, costCents: 5000, iva: 'exento', satKey: '01010101' } });
    expect(noPrice).toMatchObject({ row: 5, action: 'error', error: 'missing_price' });
    expect(unknown).toMatchObject({ row: 6, action: 'error', error: 'unknown_id' });
    expect(bad).toMatchObject({ row: 7, action: 'error', error: 'bad_price' });
  });

  it('a downloaded file uploaded as is changes nothing; missing columns keep what is saved', () => {
    const same = planImport([['ID', 'Producto', 'SKU', 'Categoría', 'Precio', 'Costo', 'Controla inventario', 'Existencia', 'Mínimo', 'IVA', 'Clave SAT', 'Activo'], [gel.id, 'Gel', 'G1', 'Cabello', 90, 40, 'Sí', 5, 2, '16', null, 'Sí']], existing, { health: false });
    expect(same.rows).toEqual([expect.objectContaining({ action: 'unchanged', changes: [] })]);
    const onlyStock = planImport([['ID', 'Existencia'], [gel.id, 0]], existing, { health: false });
    expect(onlyStock.rows[0]).toMatchObject({ action: 'update', changes: ['stock'], stock: 0 });
    expect(planImport([['Precio', 'Cantidad'], [1, 2]], existing, { health: false }).headerError).toBe('import_headers');
  });
});
