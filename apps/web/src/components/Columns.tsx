import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent, type Modifier } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Switch } from './ui';
import { TOOLBAR_BTN } from './FilterBar';

/**
 * Columns any table can show, hide and reorder; each table's choice is kept in this browser.
 * A table defines its columns once and renders `cols` (visible, in the chosen order).
 */
export interface Col<T> {
  key: string;
  label: string;
  /** Header cell (e.g. a sortable header); defaults to a plain <th> with the label */
  th?: (key: string) => ReactNode;
  td: (row: T) => ReactNode;
  /** Classes of the plain header and of the cells (alignment, width, hide on phones…) */
  className?: string;
  /** Always shown (the column that identifies the row) */
  required?: boolean;
  /** Not shown until the person turns it on */
  hidden?: boolean;
}

interface Saved {
  order: string[];
  hidden: string[];
}

const storageKey = (id: string) => `lugali.cols.${id}`;

function load(id: string): Saved | null {
  try {
    const raw = localStorage.getItem(storageKey(id));
    return raw ? (JSON.parse(raw) as Saved) : null;
  } catch {
    return null;
  }
}

export function useColumns<T>(id: string, defs: Col<T>[]) {
  const [saved, setSaved] = useState<Saved | null>(() => load(id));
  const keys = defs.map((d) => d.key).join('|');
  const byKey = useMemo(() => new Map(defs.map((d) => [d.key, d])), [keys]); // eslint-disable-line react-hooks/exhaustive-deps
  // Columns added after the choice was saved go where they're defined
  const order = useMemo(() => {
    const known = (saved?.order ?? []).filter((k) => byKey.has(k));
    for (const [i, d] of defs.entries()) if (!known.includes(d.key)) known.splice(Math.min(i, known.length), 0, d.key);
    return known;
  }, [saved, byKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const hidden = new Set(saved ? saved.hidden : defs.filter((d) => d.hidden).map((d) => d.key));
  // Columns new to a saved choice start as their definition says
  if (saved) for (const d of defs) if (d.hidden && !saved.order.includes(d.key)) hidden.add(d.key);
  const store = (s: Saved | null) => {
    setSaved(s);
    try {
      if (s) localStorage.setItem(storageKey(id), JSON.stringify(s));
      else localStorage.removeItem(storageKey(id));
    } catch {
      /* storage unavailable */
    }
  };
  const cols = order.map((k) => byKey.get(k)!).filter((d) => d.required || !hidden.has(d.key));
  const toggle = (k: string) => {
    const h = new Set(hidden);
    if (h.has(k)) h.delete(k);
    else h.add(k);
    store({ order, hidden: [...h] });
  };
  const reorder = (next: string[]) => store({ order: next, hidden: [...hidden] });
  const menu = (
    <ColumnsMenu
      items={order.map((k) => ({ key: k, label: byKey.get(k)!.label, on: byKey.get(k)!.required || !hidden.has(k), required: Boolean(byKey.get(k)!.required) }))}
      onToggle={toggle}
      onReorder={reorder}
      onReset={() => store(null)}
      testId={`cols-${id}`}
    />
  );
  return { cols, menu };
}

/** Header row and cells of a table from its columns. */
/** Headers take only the column's alignment (cell colors and weights stay in the cells). */
const thAlign = (cls = '') => (/\btext-right\b/.test(cls) ? 'text-right' : /\btext-center\b/.test(cls) ? 'text-center' : '');
export function headCells<T>(cols: Col<T>[]) {
  return cols.map((c) => (c.th ? <ThKey key={c.key}>{c.th(c.key)}</ThKey> : <th key={c.key} className={`whitespace-nowrap px-4 py-3 font-medium ${thAlign(c.className)}`}>{c.label}</th>));
}
export function rowCells<T>(cols: Col<T>[], row: T, td = 'px-4 py-3') {
  return cols.map((c) => <td key={c.key} className={`${td} ${c.className ?? ''}`}>{c.td(row)}</td>);
}
const ThKey = ({ children }: { children: ReactNode }) => <>{children}</>;

function ColumnsMenu({
  items,
  onToggle,
  onReorder,
  onReset,
  testId,
}: {
  items: { key: string; label: string; on: boolean; required: boolean }[];
  onToggle: (k: string) => void;
  onReorder: (order: string[]) => void;
  onReset: () => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const keys = items.map((i) => i.key);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onReorder(arrayMove(keys, keys.indexOf(String(active.id)), keys.indexOf(String(over.id))));
  };
  return (
    <div className="relative" ref={box}>
      <button type="button" className={TOOLBAR_BTN} aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid={testId}>
        ☰ {t('columns.button')}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-2 shadow-lg" data-testid={`${testId}-menu`}>
          <p className="px-1 pb-1 text-xs text-slate-500">{t('columns.help')}</p>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} modifiers={[restrictToVertical]}>
            <SortableContext items={keys} strategy={verticalListSortingStrategy}>
              <ul className="max-h-80 overflow-y-auto">
                {items.map((it) => <ColumnRow key={it.key} item={it} onToggle={onToggle} />)}
              </ul>
            </SortableContext>
          </DndContext>
          <button type="button" className="mt-1 px-1 text-xs text-brand-700 hover:underline" onClick={onReset}>{t('columns.reset')}</button>
        </div>
      )}
    </div>
  );
}

/** Keeps the dragged row in its column. */
const restrictToVertical: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function ColumnRow({ item, onToggle }: { item: { key: string; label: string; on: boolean; required: boolean }; onToggle: (k: string) => void }) {
  const { t } = useTranslation();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.key });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`flex items-center gap-2 rounded px-1 py-1 ${isDragging ? 'relative z-10 bg-white shadow-md' : 'hover:bg-slate-50'}`}
      data-testid={`col-row-${item.key}`}
    >
      <button
        type="button"
        className="cursor-grab touch-none rounded px-1 text-lg leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-700 active:cursor-grabbing"
        aria-label={t('columns.drag', { name: item.label })}
        title={t('columns.drag', { name: item.label })}
        {...attributes}
        {...listeners}
        data-testid={`col-drag-${item.key}`}
      >
        ⠿
      </button>
      <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
      <Switch checked={item.on} disabled={item.required} onChange={() => onToggle(item.key)} label={item.label} hideLabel testId={`col-toggle-${item.key}`} />
    </li>
  );
}

/**
 * The one table of the app: white box with a border, gray header row, one line per row.
 * Every list with columns uses it, so they all look and behave the same.
 */
export function DataTable<T>({
  cols,
  rows,
  rowKey,
  rowClassName,
  onRowClick,
  rowTestId,
  foot,
  testId,
}: {
  cols: Col<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowClassName?: (row: T) => string;
  onRowClick?: (row: T) => void;
  rowTestId?: string;
  /** Totals row: content per column key */
  foot?: Record<string, ReactNode>;
  testId?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white" data-testid={testId}>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-slate-500">
          <tr>{headCells(cols)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              className={`${onRowClick ? 'cursor-pointer hover:bg-slate-50 focus-within:bg-slate-50' : ''} ${rowClassName?.(r) ?? ''}`}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              data-testid={rowTestId}
            >
              {rowCells(cols, r, 'px-4 py-3 align-middle')}
            </tr>
          ))}
        </tbody>
        {foot && (
          <tfoot className="border-t border-slate-200 bg-slate-50 font-semibold">
            <tr>{cols.map((c) => <td key={c.key} className={`px-4 py-3 ${thAlign(c.className)}`}>{foot[c.key] ?? ''}</td>)}</tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
