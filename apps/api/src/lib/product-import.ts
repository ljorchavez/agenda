import { productInputSchema, type ProductImportRow, type ProductInput, type ProductSheetColumn } from '@agenda/shared';

/**
 * Reads an inventory spreadsheet (as rows of cells) into what each line would do: create a
 * product, update one (by its ID) or nothing. A blank optional cell clears it (SKU, costo,
 * mínimo…); a blank name, price or stock keeps what's saved; a column left out keeps it too.
 */

type Cell = string | number | boolean | null;

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();

const ALIASES: Record<ProductSheetColumn, string[]> = {
  id: ['id', 'id producto', 'product id'],
  name: ['producto', 'nombre', 'name', 'product', 'descripcion'],
  sku: ['sku', 'codigo', 'codigo de barras', 'clave interna'],
  category: ['categoria', 'category', 'familia'],
  price: ['precio', 'price', 'precio de venta', 'precio venta'],
  cost: ['costo', 'cost', 'precio de compra'],
  trackStock: ['controla inventario', 'control de inventario', 'track stock', 'inventariable'],
  stock: ['existencia', 'existencias', 'stock', 'inventario', 'cantidad'],
  minStock: ['minimo', 'existencia minima', 'stock minimo', 'min', 'min stock'],
  iva: ['iva', 'tasa iva'],
  satKey: ['clave sat', 'clave producto sat', 'clave prod serv', 'sat'],
  rx: ['requiere receta', 'receta', 'rx'],
  active: ['activo', 'active', 'activa'],
};

export function mapHeaders(headers: Cell[]): { cols: Partial<Record<ProductSheetColumn, number>>; ignored: string[] } {
  const cols: Partial<Record<ProductSheetColumn, number>> = {};
  const ignored: string[] = [];
  headers.forEach((h, i) => {
    if (h == null || String(h).trim() === '') return;
    const k = plain(String(h));
    const col = (Object.keys(ALIASES) as ProductSheetColumn[]).find((c) => ALIASES[c].includes(k));
    if (col && cols[col] === undefined) cols[col] = i;
    else ignored.push(String(h).trim());
  });
  return { cols, ignored };
}

const blank = (v: Cell | undefined) => v == null || (typeof v === 'string' && v.trim() === '');
const text = (v: Cell) => String(v).trim();

/** "$1,234.50", "1234.5", 1234.5 → 123450 cents; null when it isn't a number. */
export function toCentsCell(v: Cell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v * 100) : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[$\s]|MXN/gi, '');
  // "1.234,50" (comma decimals) vs "1,234.50"
  if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return s !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

const toInt = (v: Cell): number | null => {
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
};

const toBool = (v: Cell): boolean | null => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
  const s = plain(String(v));
  if (['si', 's', 'yes', 'y', 'true', 'verdadero', 'x', '1'].includes(s)) return true;
  if (['no', 'n', 'false', 'falso', '0'].includes(s)) return false;
  return null;
};

const toIva = (v: Cell): ProductInput['iva'] | null => {
  if (typeof v === 'number') return v === 16 || v === 0.16 ? '16' : v === 0 ? '0' : null;
  const s = plain(String(v)).replace('%', '').trim();
  if (s === '16' || s === '0.16') return '16';
  if (s === '0' || s === 'tasa 0' || s === 'cero') return '0';
  if (s.startsWith('exent')) return 'exento';
  return null;
};

/** Excel drops leading zeros of a numeric SAT key: 1010101 → "01010101". */
const toSatKey = (v: Cell): string | null => {
  const s = typeof v === 'number' ? String(Math.trunc(v)) : String(v).replace(/\s/g, '');
  return /^\d{1,8}$/.test(s) ? s.padStart(8, '0') : s;
};

export interface Existing {
  id: string;
  input: Required<Omit<ProductInput, 'initialStock' | 'locationId'>>;
  stock: number;
}

export interface PlannedRow extends ProductImportRow {
  id?: string;
  values?: ReturnType<typeof productInputSchema.parse>;
  /** Units to have at the location afterwards (only when it changes) */
  stock?: number;
}

const FIELDS = ['name', 'sku', 'category', 'priceCents', 'costCents', 'trackStock', 'minStock', 'iva', 'satKey', 'requiresPrescription', 'active'] as const;

export function planImport(table: Cell[][], existing: Map<string, Existing>, opts: { health: boolean }): { rows: PlannedRow[]; ignored: string[]; headerError?: string } {
  const { cols, ignored } = mapHeaders(table[0] ?? []);
  if (cols.name === undefined && cols.id === undefined) return { rows: [], ignored, headerError: 'import_headers' };
  const seen = new Set<string>();
  const rows: PlannedRow[] = [];
  table.slice(1).forEach((cells, i) => {
    const row = i + 2;
    if (!cells.some((c) => !blank(c))) return;
    const get = (c: ProductSheetColumn): Cell | undefined => (cols[c] === undefined ? undefined : cells[cols[c]!] ?? null);
    const fail = (error: string, name: string | null = null): void => void rows.push({ row, action: 'error', name, changes: [], error });
    const rawName = get('name');
    const shownName = blank(rawName) ? null : text(rawName!);

    const idCell = get('id');
    const id = blank(idCell) ? null : text(idCell!);
    const prev = id ? existing.get(id) : undefined;
    if (id && !prev) return fail('unknown_id', shownName);
    if (id) {
      if (seen.has(id)) return fail('duplicate_id', shownName);
      seen.add(id);
    }
    const base: Record<string, unknown> = prev
      ? { ...prev.input }
      : { name: '', sku: null, category: null, priceCents: undefined, costCents: null, trackStock: true, minStock: null, iva: '16', satKey: null, requiresPrescription: false, active: true };

    if (rawName !== undefined && !blank(rawName)) base.name = text(rawName);
    if (!prev && !base.name) return fail('missing_name');
    for (const [col, key] of [['sku', 'sku'], ['category', 'category']] as const) {
      const v = get(col);
      if (v !== undefined) base[key] = blank(v) ? null : text(v);
    }
    const price = get('price');
    if (price !== undefined && !blank(price)) {
      const c = toCentsCell(price);
      if (c == null) return fail('bad_price', shownName);
      base.priceCents = c;
    }
    if (base.priceCents === undefined) return fail('missing_price', shownName);
    const cost = get('cost');
    if (cost !== undefined) {
      if (blank(cost)) base.costCents = null;
      else {
        const c = toCentsCell(cost);
        if (c == null) return fail('bad_cost', shownName);
        base.costCents = c;
      }
    }
    for (const [col, key] of [['trackStock', 'trackStock'], ['active', 'active'], ...(opts.health ? ([['rx', 'requiresPrescription']] as const) : [])] as const) {
      const v = get(col);
      if (v !== undefined && !blank(v)) {
        const b = toBool(v);
        if (b == null) return fail(`bad_${col}`, shownName);
        base[key] = b;
      }
    }
    const min = get('minStock');
    if (min !== undefined) {
      if (blank(min)) base.minStock = null;
      else {
        const n = toInt(min);
        if (n == null) return fail('bad_min', shownName);
        base.minStock = n;
      }
    }
    const iva = get('iva');
    if (iva !== undefined && !blank(iva)) {
      const x = toIva(iva);
      if (!x) return fail('bad_iva', shownName);
      base.iva = x;
    }
    const sat = get('satKey');
    if (sat !== undefined) base.satKey = blank(sat) ? null : toSatKey(sat!);

    const parsed = productInputSchema.safeParse(base);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(issue?.message === 'sat_key_format' ? 'bad_sat_key' : `bad_${String(issue?.path[0] ?? 'value')}`, shownName);
    }
    const values = parsed.data;

    let stock: number | undefined;
    const st = get('stock');
    if (st !== undefined && !blank(st) && values.trackStock) {
      const n = toInt(st);
      if (n == null || n > 100_000) return fail('bad_stock', shownName);
      if (n !== (prev?.stock ?? 0)) stock = n;
    }

    if (!prev) {
      rows.push({ row, action: 'create', name: values.name, changes: [], values, ...(stock !== undefined ? { stock } : {}) });
      return;
    }
    const changes: string[] = FIELDS.filter((f) => (prev.input[f] ?? null) !== (values[f] ?? null));
    if (stock !== undefined) changes.push('stock');
    rows.push({ row, action: changes.length ? 'update' : 'unchanged', name: values.name, changes, id: prev.id, values, ...(stock !== undefined ? { stock } : {}) });
  });
  return { rows, ignored };
}
