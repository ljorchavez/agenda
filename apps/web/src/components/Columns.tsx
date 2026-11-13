import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

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
  const move = (k: string, by: -1 | 1) => {
    const i = order.indexOf(k);
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    store({ order: next, hidden: [...hidden] });
  };
  const menu = (
    <ColumnsMenu
      items={order.map((k) => ({ key: k, label: byKey.get(k)!.label, on: byKey.get(k)!.required || !hidden.has(k), required: Boolean(byKey.get(k)!.required) }))}
      onToggle={toggle}
      onMove={move}
      onReset={() => store(null)}
      testId={`cols-${id}`}
    />
  );
  return { cols, menu };
}

/** Header row and cells of a table from its columns. */
export function headCells<T>(cols: Col<T>[]) {
  return cols.map((c) => (c.th ? <ThKey key={c.key}>{c.th(c.key)}</ThKey> : <th key={c.key} className={`px-4 py-3 font-medium ${c.className ?? ''}`}>{c.label}</th>));
}
export function rowCells<T>(cols: Col<T>[], row: T, td = 'px-4 py-3') {
  return cols.map((c) => <td key={c.key} className={`${td} ${c.className ?? ''}`}>{c.td(row)}</td>);
}
const ThKey = ({ children }: { children: ReactNode }) => <>{children}</>;

function ColumnsMenu({
  items,
  onToggle,
  onMove,
  onReset,
  testId,
}: {
  items: { key: string; label: string; on: boolean; required: boolean }[];
  onToggle: (k: string) => void;
  onMove: (k: string, by: -1 | 1) => void;
  onReset: () => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
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
  return (
    <div className="relative" ref={box}>
      <button type="button" className="input !w-auto !py-1 !px-2 !text-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid={testId}>
        ☰ {t('columns.button')}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-64 rounded-lg border border-slate-200 bg-white p-2 shadow-lg" data-testid={`${testId}-menu`}>
          <p className="px-1 pb-1 text-xs text-slate-500">{t('columns.help')}</p>
          <ul className="max-h-80 overflow-y-auto">
            {items.map((it, i) => (
              <li key={it.key} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-slate-50">
                <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                  <input type="checkbox" checked={it.on} disabled={it.required} onChange={() => onToggle(it.key)} data-testid={`col-toggle-${it.key}`} />
                  <span className="truncate">{it.label}</span>
                </label>
                <button type="button" className="px-1 text-slate-400 hover:text-slate-800 disabled:opacity-30" disabled={i === 0} aria-label={t('columns.up')} onClick={() => onMove(it.key, -1)} data-testid={`col-up-${it.key}`}>↑</button>
                <button type="button" className="px-1 text-slate-400 hover:text-slate-800 disabled:opacity-30" disabled={i === items.length - 1} aria-label={t('columns.down')} onClick={() => onMove(it.key, 1)} data-testid={`col-down-${it.key}`}>↓</button>
              </li>
            ))}
          </ul>
          <button type="button" className="mt-1 px-1 text-xs text-brand-700 hover:underline" onClick={onReset}>{t('columns.reset')}</button>
        </div>
      )}
    </div>
  );
}
