/**
 * Point-of-sale helpers with Claude:
 *  - a product from a photo (label, can, box) or a few words: name, category, IVA, SAT key, barcode;
 *  - a spreadsheet with any column names (or a title above the headers) read as our template.
 * The model only proposes: the person reviews the form or the import preview before saving.
 */
import { z } from 'zod';
import { IVA_OPTIONS, PRODUCT_SHEET_COLUMNS, PRODUCT_SHEET_HEADERS, type ProductSheetColumn, type ProductSuggestionDto } from '@agenda/shared';
import type { Db } from '../db/client.js';
import { askJson } from './ai.js';
import { AppError } from './errors.js';

type Cell = string | number | boolean | null;

const suggestionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(40).nullish(),
  iva: z.enum(IVA_OPTIONS).catch('16'),
  satKey: z.string().nullish(),
  sku: z.string().nullish(),
  priceCents: z.number().int().min(0).max(100_000_000).nullish().catch(null),
});

/** Cleans what the model proposed: an existing category keeps its spelling, codes must look like codes. */
export function parseSuggestion(raw: unknown, categories: string[]): ProductSuggestionDto {
  const r = suggestionSchema.safeParse(raw);
  if (!r.success) throw new AppError(502, 'ai_bad_answer', 'The AI answer could not be read');
  const v = r.data;
  const cat = v.category?.trim() || null;
  const same = cat ? categories.find((c) => c.toLocaleLowerCase('es') === cat.toLocaleLowerCase('es')) : undefined;
  const sat = v.satKey?.replace(/\D/g, '') ?? '';
  const sku = v.sku?.replace(/\s/g, '') ?? '';
  return {
    name: v.name,
    category: same ?? cat,
    iva: v.iva,
    satKey: /^\d{8}$/.test(sat) ? sat : null,
    sku: /^\d{8,14}$/.test(sku) ? sku : null,
    priceCents: v.priceCents ?? null,
  };
}

export async function suggestProduct(
  db: Db,
  tenantId: string,
  o: { text?: string; image?: { data: string; mediaType: string }; businessType: string; categories: string[] },
): Promise<ProductSuggestionDto> {
  const system = [
    'Eres el asistente del punto de venta de un negocio en México. Con una foto de un producto (etiqueta, envase, caja) o una descripción breve,',
    'propones cómo darlo de alta. Responde SOLO un objeto JSON con estas llaves:',
    '{"name": nombre comercial claro en español con marca y presentación (p. ej. "Sayer Lack Tinta al alcohol Chocolate 1 L"),',
    ' "category": una de las categorías existentes si alguna aplica, si no una nueva corta,',
    ' "iva": "16" | "0" | "exento" (alimentos básicos y medicinas suelen ser "0"),',
    ' "satKey": clave de producto SAT de 8 dígitos (catálogo c_ClaveProdServ) o null si no estás razonablemente seguro,',
    ' "sku": el número del código de barras si se lee completo en la foto, si no null,',
    ' "priceCents": precio en centavos solo si aparece impreso, si no null}.',
    'No inventes datos que no se vean o no sean de conocimiento general.',
  ].join('\n');
  const ask = [`Giro del negocio: ${o.businessType}.`, `Categorías existentes: ${o.categories.length ? o.categories.join(', ') : '(ninguna)'}.`, o.text ? `Descripción: ${o.text}` : 'Describe el producto de la foto.'].join('\n');
  const content = [
    ...(o.image ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: o.image.mediaType, data: o.image.data } }] : []),
    { type: 'text' as const, text: ask },
  ];
  return parseSuggestion(await askJson(db, tenantId, 'product', { system, content, maxTokens: 400 }), o.categories);
}

const mapSchema = z.object({
  headerRow: z.number().int().min(0).max(20),
  columns: z.record(z.string(), z.string()),
});

/**
 * Rewrites the table so its header row uses our column names: rows above the headers (titles,
 * blank lines) are dropped; columns that match nothing keep their own name and are ignored.
 */
export function applyColumnMap(table: Cell[][], headerRow: number, columns: Record<string, string>): { table: Cell[][]; mapped: { from: string; to: string }[] } {
  const header = table[headerRow] ?? [];
  const used = new Set<ProductSheetColumn>();
  const mapped: { from: string; to: string }[] = [];
  const newHeader = header.map((h, i) => {
    const to = columns[String(i)] as ProductSheetColumn | undefined;
    if (to && (PRODUCT_SHEET_COLUMNS as readonly string[]).includes(to) && !used.has(to)) {
      used.add(to);
      const name = PRODUCT_SHEET_HEADERS[to];
      if (String(h ?? '').trim() !== name) mapped.push({ from: String(h ?? '').trim() || `#${i + 1}`, to: name });
      return name;
    }
    return h;
  });
  return { table: [newHeader, ...table.slice(headerRow + 1)], mapped };
}

/** Asks which row has the headers and what each column is. Only the first rows are sent. */
export async function mapImportTable(db: Db, tenantId: string, table: Cell[][]): Promise<{ table: Cell[][]; mapped: { from: string; to: string }[] }> {
  const sample = table.slice(0, 8).map((r) => r.slice(0, 30).map((c) => (c == null ? '' : String(c).slice(0, 40))));
  const fields = PRODUCT_SHEET_COLUMNS.map((c) => `${c} (${PRODUCT_SHEET_HEADERS[c]})`).join(', ');
  const system = [
    'Lees hojas de cálculo de inventario de pequeños negocios en México. Te doy las primeras filas como arreglo JSON.',
    'Identifica la fila de encabezados (índice desde 0; puede haber títulos arriba) y a qué campo corresponde cada columna.',
    `Campos posibles: ${fields}.`,
    'Notas: "name" es el nombre o descripción del producto; "sku" es el código o código de barras; "price" el precio de venta; "cost" el de compra;',
    '"stock" la existencia o cantidad disponible; "id" SOLO si es el ID numérico de Lugali. Omite columnas que no correspondan a ningún campo.',
    'Responde SOLO JSON: {"headerRow": n, "columns": {"<índice de columna>": "<campo>"}}',
  ].join('\n');
  const raw = await askJson(db, tenantId, 'import', { system, content: [{ type: 'text', text: JSON.stringify(sample) }], maxTokens: 300 });
  const r = mapSchema.safeParse(raw);
  if (!r.success) throw new AppError(502, 'ai_bad_answer', 'The AI answer could not be read');
  return applyColumnMap(table, r.data.headerRow, r.data.columns);
}
