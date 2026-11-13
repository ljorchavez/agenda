import { z } from 'zod';

/**
 * Electronic invoicing (CFDI 4.0) through Facturapi. Each business invoices with its own RFC and
 * CSD; the platform only manages the connection. Available when the platform has a Facturapi
 * key (FACTURAPI_USER_KEY); each invoice has a cost per timbre.
 */

/** Regímenes fiscales (SAT c_RegimenFiscal): the usual ones first, then the rest of the catalog. */
export const TAX_SYSTEMS: readonly (readonly [string, string])[] = [
  ['612', 'Personas Físicas con Actividades Empresariales y Profesionales'],
  ['626', 'Régimen Simplificado de Confianza (RESICO)'],
  ['605', 'Sueldos y Salarios e Ingresos Asimilados a Salarios'],
  ['601', 'General de Ley Personas Morales'],
  ['621', 'Incorporación Fiscal'],
  ['606', 'Arrendamiento'],
  ['625', 'Plataformas Tecnológicas'],
  ['616', 'Sin obligaciones fiscales'],
  ['603', 'Personas Morales con Fines no Lucrativos'],
  ['607', 'Enajenación o Adquisición de Bienes'],
  ['608', 'Demás ingresos'],
  ['610', 'Residentes en el Extranjero sin Establecimiento Permanente en México'],
  ['611', 'Ingresos por Dividendos (socios y accionistas)'],
  ['614', 'Ingresos por intereses'],
  ['615', 'Ingresos por obtención de premios'],
  ['620', 'Sociedades Cooperativas de Producción que optan por diferir sus ingresos'],
  ['622', 'Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras'],
  ['623', 'Opcional para Grupos de Sociedades'],
  ['624', 'Coordinados'],
];
/** Usos de CFDI (SAT c_UsoCFDI) a customer usually picks. */
export const CFDI_USES: readonly (readonly [string, string])[] = [
  ['G03', 'Gastos en general'],
  ['D01', 'Honorarios médicos, dentales y gastos hospitalarios'],
  ['D04', 'Donativos'],
  ['D10', 'Pagos por servicios educativos (colegiaturas)'],
  ['G01', 'Adquisición de mercancías'],
  ['S01', 'Sin efectos fiscales'],
  ['CP01', 'Pagos'],
];
/** Formas de pago (SAT c_FormaPago) for each way the business records a payment. */
export const PAYMENT_FORMS: Record<string, string> = {
  cash: '01',
  transfer: '03',
  card: '04',
  credit_card: '04',
  debit_card: '28',
  mercadopago: '04',
  terminal: '04',
  other: '99',
};
export const IVA_OPTIONS = ['16', '0', 'exento'] as const;
export type IvaOption = (typeof IVA_OPTIONS)[number];

/**
 * Suggested product/service key (SAT c_ClaveProdServ) and IVA by giro. Only a starting point: the
 * business confirms it with its accountant (Configuración → Facturación).
 */
export function invoicingDefaultsFor(businessType: string): { productKey: string; description: string; iva: IvaOption; use: string } {
  const health: Record<string, string> = {
    medical: 'Consulta médica',
    dental: 'Servicio dental',
    psychology: 'Consulta psicológica',
    physiotherapy: 'Sesión de fisioterapia',
    nutrition: 'Consulta de nutrición',
  };
  if (health[businessType]) return { productKey: '85121500', description: health[businessType]!, iva: 'exento', use: 'D01' };
  if (['restaurant', 'cafe', 'bar'].includes(businessType)) return { productKey: '90101500', description: 'Consumo de alimentos', iva: '16', use: 'G03' };
  // "No existe en el catálogo": valid for the SAT while the business picks its own key
  return { productKey: '01010101', description: 'Servicio', iva: '16', use: 'G03' };
}

const rfcRegex = /^([A-ZÑ&]{3,4})\d{6}([A-Z\d]{3})$/;
export const rfcSchema = z.string().trim().toUpperCase().regex(rfcRegex, 'rfc_format');
export const PUBLIC_RFC = 'XAXX010101000';

/** What the business sets to invoice (not secret; keys live encrypted apart). */
export const invoicingSettingsSchema = z.object({
  rfc: rfcSchema,
  legalName: z.string().trim().min(2).max(250),
  taxSystem: z.string().regex(/^\d{3}$/),
  zip: z.string().regex(/^\d{5}$/),
  series: z.string().trim().max(10).nullable().optional(),
  productKey: z.string().regex(/^\d{8}$/),
  description: z.string().trim().min(2).max(200),
  iva: z.enum(IVA_OPTIONS),
  /** Email a copy of each invoice to the customer */
  autoEmail: z.boolean().optional(),
});
export type InvoicingSettings = z.infer<typeof invoicingSettingsSchema>;

/** A customer's fiscal data (constancia de situación fiscal). */
export const customerFiscalSchema = z.object({
  rfc: rfcSchema,
  legalName: z.string().trim().min(2).max(250),
  taxSystem: z.string().regex(/^\d{3}$/),
  zip: z.string().regex(/^\d{5}$/),
  use: z.string().regex(/^[A-Z]{1,2}\d{2}$/),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
});
export type CustomerFiscal = z.infer<typeof customerFiscalSchema>;

/** What was read from a Constancia de Situación Fiscal (SAT): to review before saving. */
export interface CsfReadDto {
  fiscal: Partial<Pick<CustomerFiscal, 'rfc' | 'legalName' | 'taxSystem' | 'zip'>>;
  /** Every régimen listed, in order (the first one is suggested) */
  regimes: string[];
  personType: 'fisica' | 'moral' | null;
  /** "ACTIVO" when registered and active with the SAT */
  status: string | null;
  /** not_csf · no_text (a photo or scan) · inactive · missing_<field> */
  warnings: string[];
}

/** The customer's saved Constancia de Situación Fiscal (the file stays private). */
export interface FiscalDocDto {
  fileName: string | null;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
}

export const invoiceRequestSchema = z.object({
  /** null: público en general */
  customer: customerFiscalSchema.nullable(),
  /** Save it as the customer's fiscal data for next time */
  save: z.boolean().optional(),
});
export const invoiceCancelSchema = z.object({ motive: z.enum(['02', '03']) });

export interface InvoiceDto {
  id: string;
  paymentId: string | null;
  customerId: string | null;
  uuid: string | null;
  series: string | null;
  folio: number | null;
  totalCents: number;
  status: 'valid' | 'canceled' | 'pending';
  test: boolean;
  createdAt: string;
}
export interface InvoicingStatusDto {
  /** The platform has Facturapi connected */
  available: boolean;
  settings: InvoicingSettings | null;
  /** The business's issuer exists in Facturapi */
  connected: boolean;
  /** CSD uploaded: real (live) invoices; otherwise test invoices only */
  live: boolean;
  defaults: ReturnType<typeof invoicingDefaultsFor>;
}
