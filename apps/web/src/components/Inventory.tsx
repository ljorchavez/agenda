import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import { PRODUCT_SHEET_COLUMNS, PRODUCT_SHEET_HEADERS, type ProductDto, type ProductImportResult, type ProductSheetColumn } from '@agenda/shared';
import { api } from '../lib/api';
import { ErrorText, Modal } from './ui';

type Cell = string | number | boolean | null;

const columnsFor = (health: boolean) => PRODUCT_SHEET_COLUMNS.filter((c) => health || c !== 'rx');

const yes = (b: boolean) => (b ? 'Sí' : 'No');

function cellOf(p: ProductDto, c: ProductSheetColumn): Cell {
  switch (c) {
    case 'id': return p.number;
    case 'name': return p.name;
    case 'sku': return p.sku;
    case 'category': return p.category;
    case 'price': return p.priceCents / 100;
    case 'cost': return p.costCents == null ? null : p.costCents / 100;
    case 'trackStock': return yes(p.trackStock);
    case 'stock': return p.trackStock ? p.stock : null;
    case 'minStock': return p.minStock;
    case 'iva': return p.iva;
    case 'satKey': return p.satKey;
    case 'rx': return yes(p.requiresPrescription);
    case 'active': return yes(p.active);
  }
}

const WIDTHS: Record<ProductSheetColumn, number> = { id: 8, name: 32, sku: 14, category: 16, price: 10, cost: 10, trackStock: 18, stock: 11, minStock: 9, iva: 8, satKey: 12, rx: 15, active: 8 };

function save(bytes: Uint8Array, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Downloads the products shown (or an empty template) as an Excel file to edit and upload back. */
export async function downloadInventory(list: ProductDto[] | null, opts: { health: boolean; locationName?: string | null; categories?: string[] }) {
  const { writeXlsx } = await import('@agenda/shared/xlsx');
  const cols = columnsFor(opts.health);
  const rows: Cell[][] = [cols.map((c) => PRODUCT_SHEET_HEADERS[c])];
  for (const p of list ?? []) rows.push(cols.map((c) => cellOf(p, c)));
  const day = new Date().toISOString().slice(0, 10);
  const place = opts.locationName ? `-${opts.locationName.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}` : '';
  // Dropdowns to fill it in without typos (categories also take new ones)
  const choices: Partial<Record<ProductSheetColumn, { values: string[]; allowOther?: boolean }>> = {
    category: { values: opts.categories ?? [], allowOther: true },
    trackStock: { values: ['Sí', 'No'] },
    iva: { values: ['16', '0', 'exento'] },
    rx: { values: ['Sí', 'No'] },
    active: { values: ['Sí', 'No'] },
  };
  const lists = cols.flatMap((c, col) => (choices[c] ? [{ col, ...choices[c]! }] : []));
  save(writeXlsx(rows, { sheet: 'Inventario', widths: cols.map((c) => WIDTHS[c]), lists }), list ? `inventario${place}-${day}.xlsx` : 'plantilla-inventario.xlsx');
}

async function readTable(file: File): Promise<Cell[][]> {
  const { readCsv, readXlsx } = await import('@agenda/shared/xlsx');
  if (/\.csv$/i.test(file.name) || file.type === 'text/csv') return readCsv(await file.text());
  return readXlsx(new Uint8Array(await file.arrayBuffer()));
}

/** Upload an Excel (or CSV): shows what would change, then applies it. */
export function ImportModal({ locationId, locationName, onTemplate, onClose, onDone }: { locationId: string; locationName: string | null; onTemplate?: () => void; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [table, setTable] = useState<Cell[][] | null>(null);
  const [fileName, setFileName] = useState('');
  const [readError, setReadError] = useState(false);
  const run = useMutation({
    mutationFn: (v: { dryRun: boolean; table: Cell[][] }) => api<ProductImportResult>('/products/import', { method: 'POST', body: { locationId, ...v } }),
    onSuccess: (r) => {
      if (r.applied) onDone();
    },
  });
  const r = run.data;
  const pick = async (file: File) => {
    setReadError(false);
    run.reset();
    setFileName(file.name);
    try {
      const rows = await readTable(file);
      setTable(rows);
      run.mutate({ dryRun: true, table: rows });
    } catch {
      setTable(null);
      setReadError(true);
    }
  };
  return (
    <Modal open title={t('pos.inventory.importTitle')} onClose={onClose} wide>
      <div className="space-y-3 text-sm" data-testid="import-modal">
        <p className="text-slate-600">{t('pos.inventory.importHelp')}</p>
        {locationName && <p className="text-xs text-slate-500">{t('pos.inventory.stockAt', { place: locationName })}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-secondary" onClick={() => input.current?.click()} data-testid="import-pick">{fileName ? t('pos.inventory.otherFile') : t('pos.inventory.pickFile')}</button>
          {fileName && <span className="text-slate-600">{fileName}</span>}
          {!fileName && onTemplate && (
            <button type="button" className="text-xs text-brand-700 hover:underline" onClick={onTemplate}>{t('pos.inventory.template')}</button>
          )}
          <input
            ref={input}
            type="file"
            accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            className="hidden"
            data-testid="import-file"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void pick(f);
            }}
          />
        </div>
        {readError && <p className="rounded-lg bg-rose-50 p-2 text-rose-700">{t('pos.inventory.readError')}</p>}
        <ErrorText error={run.error} ns="pos" />
        {r && (
          <div className="space-y-2" data-testid="import-result">
            <p className={`rounded-lg p-2 ${r.applied ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-50 text-slate-700'}`} data-testid="import-summary">
              {r.applied ? '✓ ' : ''}
              {t(r.applied ? 'pos.inventory.applied' : 'pos.inventory.preview', { created: r.created, updated: r.updated, unchanged: r.unchanged })}
              {r.errors > 0 && <b className="ml-1 text-rose-700">{t('pos.inventory.withErrors', { count: r.errors })}</b>}
            </p>
            {r.ignored.length > 0 && <p className="text-xs text-slate-500">{t('pos.inventory.ignored', { list: r.ignored.join(', ') })}</p>}
            <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
              {r.rows.filter((x) => x.action !== 'unchanged').slice(0, 300).map((x) => (
                <li key={x.row} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-1.5" data-testid={`import-row-${x.action}`}>
                  <span>
                    <span className="mr-2 text-xs text-slate-400">{t('pos.inventory.line', { n: x.row })}</span>
                    {x.name ?? '—'}
                  </span>
                  {x.action === 'error' ? (
                    <span className="text-xs text-rose-700">{t(`pos.inventory.errors.${x.error}`, { defaultValue: x.error })}</span>
                  ) : (
                    <span className={`text-xs ${x.action === 'create' ? 'text-emerald-700' : 'text-sky-700'}`}>
                      {x.action === 'create' ? t('pos.inventory.new') : x.changes.map((c) => t(`pos.inventory.fields.${c}`)).join(', ')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>{r?.applied ? t('common.close') : t('common.cancel')}</button>
          {r && !r.applied && r.created + r.updated > 0 && (
            <button type="button" className="btn-primary" disabled={run.isPending} onClick={() => table && run.mutate({ dryRun: false, table })} data-testid="import-apply">
              {t('pos.inventory.apply', { count: r.created + r.updated })}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * A table cell edited in place with a double click: Enter or leaving saves, Esc cancels.
 * `parse` turns the text into the value to save (null = invalid, stays open).
 */
export function EditableCell<T>({
  value,
  display,
  parse,
  onSave,
  canEdit,
  inputMode,
  className = '',
  testId,
  allowEmpty,
}: {
  value: string;
  display: ReactNode;
  parse: (s: string) => T | null;
  onSave: (v: T | null) => Promise<unknown>;
  /** An empty cell clears the value (saves null) */
  allowEmpty?: boolean;
  canEdit: boolean;
  inputMode?: 'decimal' | 'numeric' | 'text';
  className?: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState(false);
  if (!editing) {
    return (
      <span
        className={`${canEdit ? 'cursor-text rounded px-1 -mx-1 hover:bg-brand-50' : ''} ${className}`}
        title={canEdit ? t('pos.inventory.dblClick') : undefined}
        onDoubleClick={() => {
          if (!canEdit) return;
          setDraft(value);
          setBad(false);
          setEditing(true);
        }}
        data-testid={testId}
      >
        {display}
      </span>
    );
  }
  const commit = async () => {
    if (draft.trim() === value.trim()) return setEditing(false);
    const v = allowEmpty && draft.trim() === '' ? null : parse(draft);
    if (v === null && !(allowEmpty && draft.trim() === '')) return setBad(true);
    setBusy(true);
    try {
      await onSave(v);
      setEditing(false);
    } catch {
      setBad(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <input
      autoFocus
      className={`input !py-0.5 !px-1.5 ${bad ? '!border-rose-500' : ''} ${className}`}
      value={draft}
      inputMode={inputMode}
      disabled={busy}
      onChange={(e) => {
        setDraft(e.target.value);
        setBad(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void commit();
        } else if (e.key === 'Escape') setEditing(false);
      }}
      onBlur={() => void commit()}
      data-testid={testId ? `${testId}-input` : undefined}
    />
  );
}
