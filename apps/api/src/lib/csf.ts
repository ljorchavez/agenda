import type { CsfReadDto } from '@agenda/shared';

/**
 * Reads the data to invoice someone from their Constancia de Situación Fiscal (the PDF the SAT
 * gives out). It has a text layer, so no OCR: a photo or scan can't be read and is said so.
 * The result is a suggestion the business reviews before saving.
 */

/** c_RegimenFiscal by the words the SAT prints in the constancia. */
const REGIMES: [string, RegExp][] = [
  ['601', /general de ley personas morales/],
  ['603', /personas morales con fines no lucrativos/],
  ['605', /sueldos y salarios/],
  ['606', /arrendamiento/],
  ['607', /enajenacion o adquisicion de bienes/],
  ['608', /demas ingresos/],
  ['610', /residentes en el extranjero/],
  ['611', /dividendos/],
  ['612', /actividades empresariales y profesionales/],
  ['614', /ingresos por intereses/],
  ['615', /obtencion de premios/],
  ['616', /sin obligaciones fiscales/],
  ['620', /sociedades cooperativas de produccion/],
  ['621', /incorporacion fiscal/],
  ['622', /agricolas, ganaderas|actividades agricolas/],
  ['623', /grupos de sociedades/],
  ['624', /coordinados/],
  ['625', /plataformas tecnologicas/],
  ['626', /simplificado de confianza/],
];

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const clean = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export function parseCsfText(raw: string): CsfReadDto {
  const text = raw.replace(/\s+/g, ' ').trim();
  const out: CsfReadDto = { fiscal: {}, regimes: [], personType: null, status: null, warnings: [] };
  if (text.length < 20) {
    out.warnings.push('no_text');
    return out;
  }
  const low = plain(text);
  if (!/constancia de situacion fiscal|cedula de identificacion fiscal/.test(low)) out.warnings.push('not_csf');

  const rfc = /RFC:?\s*([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/.exec(text) ?? /\b([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3})\b/.exec(text);
  if (rfc) out.fiscal.rfc = rfc[1]!;
  out.personType = rfc ? (rfc[1]!.length === 12 ? 'moral' : 'fisica') : null;

  // Persona moral: name exactly as registered, without the "régimen capital" (CFDI 4.0)
  const moral = /Denominaci[oó]n\s*\/?\s*Raz[oó]n\s*Social:?\s*(.+?)\s*(?:R[eé]gimen\s*Capital|Nombre\s*Comercial|Fecha\s*inicio|Estatus)/i.exec(text);
  // Persona física: names then both surnames (the second may be empty)
  const fisica = /Nombre\s*\(s\):?\s*(.+?)\s*Primer\s*Apellido:?\s*(.+?)\s*Segundo\s*Apellido:?\s*(.*?)\s*(?:Fecha\s*inicio|Estatus|Fecha\s*de\s*[uú]ltimo|Nombre\s*Comercial)/i.exec(text);
  if (moral && clean(moral[1])) {
    out.fiscal.legalName = clean(moral[1]).toUpperCase();
    out.personType = 'moral';
  } else if (fisica) {
    out.fiscal.legalName = [fisica[1], fisica[2], fisica[3]].map(clean).filter(Boolean).join(' ').toUpperCase();
    out.personType = 'fisica';
  }

  const zip = /C[oó]digo\s*Postal:?\s*(\d{5})/i.exec(text);
  if (zip) out.fiscal.zip = zip[1]!;

  const status = /Estatus\s*en\s*el\s*padr[oó]n:?\s*([A-ZÁÉÍÓÚ ]+?)(?:\s+Fecha|\s+Nombre|\s+Datos|$)/i.exec(text);
  if (status) {
    out.status = clean(status[1]).toUpperCase();
    if (out.status !== 'ACTIVO') out.warnings.push('inactive');
  }

  // Only the "Regímenes" table: other sections (obligaciones) mention the same words
  const start = low.search(/regimenes:?\s*regimen/);
  const from = start >= 0 ? start : low.indexOf('regimen');
  const end = low.indexOf('obligaciones', from + 1);
  const section = from >= 0 ? low.slice(from, end > from ? end : undefined) : '';
  out.regimes = REGIMES.map(([code, re]) => ({ code, at: section.search(re) }))
    .filter((r) => r.at >= 0)
    .sort((a, b) => a.at - b.at)
    .map((r) => r.code);
  if (out.regimes[0]) out.fiscal.taxSystem = out.regimes[0];

  for (const k of ['rfc', 'legalName', 'zip', 'taxSystem'] as const) if (!out.fiscal[k]) out.warnings.push(`missing_${k}`);
  return out;
}

/** Text of a PDF (all pages); empty when it has no text layer. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join(' ') : text;
}

export async function readCsf(file: { type: string; arrayBuffer(): Promise<ArrayBuffer> }): Promise<CsfReadDto> {
  if (file.type !== 'application/pdf') return { fiscal: {}, regimes: [], personType: null, status: null, warnings: ['no_text'] };
  try {
    return parseCsfText(await pdfText(new Uint8Array(await file.arrayBuffer())));
  } catch {
    return { fiscal: {}, regimes: [], personType: null, status: null, warnings: ['no_text'] };
  }
}
