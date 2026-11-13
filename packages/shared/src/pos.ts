import { z } from 'zod';
import { IVA_OPTIONS } from './invoicing';
import { IN_PERSON_ACCEPTED, IN_PERSON_METHODS } from './methods';

/**
 * Light point of sale: a product catalog with stock per location and counter sales with several
 * lines and split payments. Sales go into the cash closing and can be invoiced (CFDI) as a whole.
 */

/** Ways to pay at the counter (online methods and gift cards have their own flows). */
export const POS_METHODS = IN_PERSON_METHODS;
export type PosMethod = (typeof IN_PERSON_ACCEPTED)[number];

/** SAT "No existe en el catálogo": used when a product has no clave de producto. */
export const DEFAULT_PRODUCT_SAT_KEY = '01010101';

const money = z.number().int().min(0).max(100_000_000);
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const productInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sku: optText(60),
  category: optText(60),
  priceCents: money,
  costCents: money.nullish().transform((v) => v ?? null),
  trackStock: z.boolean().default(true),
  minStock: z.number().int().min(0).max(100_000).nullish().transform((v) => v ?? null),
  iva: z.enum(IVA_OPTIONS).default('16'),
  satKey: z
    .string()
    .trim()
    .regex(/^\d{8}$/, 'sat_key_format')
    .nullish()
    .or(z.literal('').transform(() => null))
    .transform((v) => v ?? null),
  requiresPrescription: z.boolean().default(false),
  active: z.boolean().default(true),
  /** Only when creating: units on hand at `locationId` (or the main location) */
  initialStock: z.number().int().min(0).max(100_000).optional(),
  locationId: z.string().uuid().optional(),
});
export type ProductInput = z.input<typeof productInputSchema>;

export interface ProductDto {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  priceCents: number;
  costCents: number | null;
  trackStock: boolean;
  minStock: number | null;
  iva: (typeof IVA_OPTIONS)[number];
  satKey: string | null;
  requiresPrescription: boolean;
  active: boolean;
  /** Units at the requested location (or across all of them when none was asked) */
  stock: number;
  stockByLocation: Record<string, number>;
  /** At or below the minimum (only when it tracks stock and has one) */
  low: boolean;
}

export const STOCK_REASONS = ['in', 'adjust', 'sale', 'return'] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

export const stockAdjustSchema = z.object({
  locationId: z.string().uuid().optional(),
  /** `in`: add what arrived; `set`: the count on hand now (physical count) */
  mode: z.enum(['in', 'set']),
  qty: z.number().int().min(0).max(100_000),
  note: optText(200),
});

/** Inventory from a spreadsheet: first row = headers (Producto, Precio, Existencia…; ID to update). */
const importCell = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
export const productImportSchema = z.object({
  locationId: z.string().uuid().optional(),
  /** Only checks and says what would change */
  dryRun: z.boolean().default(true),
  table: z.array(z.array(importCell).max(40)).min(1).max(5001),
});
export type ProductImportInput = z.input<typeof productImportSchema>;

export interface ProductImportRow {
  /** Line in the file (2 = first product, after the headers) */
  row: number;
  action: 'create' | 'update' | 'unchanged' | 'error';
  name: string | null;
  /** Fields that change (name, priceCents, stock…) */
  changes: string[];
  error?: string;
}
export interface ProductImportResult {
  rows: ProductImportRow[];
  created: number;
  updated: number;
  unchanged: number;
  errors: number;
  applied: boolean;
  /** Headers not recognized (ignored) */
  ignored: string[];
}

/** Spreadsheet columns, in download order; the import accepts these and a few aliases. */
export const PRODUCT_SHEET_COLUMNS = ['id', 'name', 'sku', 'category', 'price', 'cost', 'trackStock', 'stock', 'minStock', 'iva', 'satKey', 'rx', 'active'] as const;
export type ProductSheetColumn = (typeof PRODUCT_SHEET_COLUMNS)[number];
export const PRODUCT_SHEET_HEADERS: Record<ProductSheetColumn, string> = {
  id: 'ID',
  name: 'Producto',
  sku: 'SKU',
  category: 'Categoría',
  price: 'Precio',
  cost: 'Costo',
  trackStock: 'Controla inventario',
  stock: 'Existencia',
  minStock: 'Mínimo',
  iva: 'IVA',
  satKey: 'Clave SAT',
  rx: 'Requiere receta',
  active: 'Activo',
};

export interface StockMoveDto {
  id: string;
  locationId: string;
  qtyChange: number;
  qtyAfter: number;
  reason: StockReason;
  saleNumber: number | null;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
}

export const saleItemInputSchema = z
  .object({
    productId: z.string().uuid().optional(),
    /** Free line (a service without booking, a misc. charge) */
    name: z.string().trim().min(1).max(120).optional(),
    qty: z.number().int().min(1).max(999),
    /** Price per unit; defaults to the product's price */
    unitCents: money.optional(),
  })
  .refine((i) => i.productId || (i.name && i.unitCents != null), { message: 'item_needs_product_or_name' });

export const saleCreateSchema = z.object({
  locationId: z.string().uuid().optional(),
  customerId: z.string().uuid().nullish(),
  items: z.array(saleItemInputSchema).min(1).max(50),
  payments: z
    .array(z.object({ method: z.enum(IN_PERSON_ACCEPTED), amountCents: money }))
    .min(1)
    .max(3),
  notes: optText(300),
  /** Made by the device: the same sale sent twice (a retry after a cut) is saved once */
  clientId: z.string().uuid().optional(),
  /** Charged without internet and sent later: stock may go below zero, date is soldAt */
  offline: z.boolean().optional(),
  soldAt: z.string().datetime().optional(),
});
export type SaleCreateInput = z.input<typeof saleCreateSchema>;

export interface SaleItem {
  productId: string | null;
  name: string;
  qty: number;
  unitCents: number;
  totalCents: number;
  iva: (typeof IVA_OPTIONS)[number];
  satKey: string | null;
}

export interface SaleDto {
  id: string;
  number: number;
  locationId: string;
  locationName: string | null;
  customerId: string | null;
  customerName: string | null;
  /** Customer on its payments (the hidden counter customer when none was chosen) */
  payerCustomerId: string | null;
  items: SaleItem[];
  totalCents: number;
  payments: { id: string; method: string; amountCents: number }[];
  status: 'paid' | 'canceled';
  notes: string | null;
  createdByName: string | null;
  createdAt: string;
  /** Charged without internet and uploaded later */
  offline: boolean;
  /** Its valid invoice, if any */
  invoice: { id: string; series: string | null; folio: number | null; test: boolean } | null;
}

/** Sums the lines; prices are integers (cents). */
export const saleTotal = (items: { qty: number; unitCents: number }[]) => items.reduce((a, i) => a + i.qty * i.unitCents, 0);

/** Everything a printed ticket shows (sale + who sells: business, fiscal data, address). */
export interface SaleTicketDto {
  business: { name: string; legalName: string | null; rfc: string | null; address: string | null; phone: string | null };
  locationName: string | null;
  /** Several locations: show which one */
  multiLocation: boolean;
  timezone: string;
  /** The business can invoice (shows "ask for your invoice") */
  invoicing: boolean;
  sale: SaleDto;
}

/** The ticket's header for a location, kept on the device to print without internet. */
export type PosHeaderDto = Omit<SaleTicketDto, 'sale'>;
