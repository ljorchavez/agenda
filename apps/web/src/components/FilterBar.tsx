import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** Small control style shared by every filter bar. */
/** Filters and toolbars: one control height (36px) everywhere, so rows line up. */
export const FILTER_CTRL = 'input !h-9 !w-auto !py-0 !px-2.5 !text-sm';
/** Buttons that sit in a filter row or toolbar, same height as the controls. */
export const TOOLBAR_BTN = 'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40';

/**
 * Compact filters: one row with the main controls (period, search) and a "Filtros" button that
 * opens the rest. The button shows how many extra filters are on.
 */
export function FilterBar({
  primary,
  children,
  active,
  onClear,
}: {
  primary: ReactNode;
  children?: ReactNode;
  active: number;
  onClear?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-2">
        {primary}
        {children && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm font-medium ${active ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}
          >
            <span aria-hidden>⚲</span>
            {t('filters.more')}
            {active > 0 && <span className="rounded-full bg-brand-700 px-1.5 text-xs text-white">{active}</span>}
            <span className="text-xs" aria-hidden>{open ? '▴' : '▾'}</span>
          </button>
        )}
        {active > 0 && onClear && (
          <button type="button" className="text-sm font-medium text-brand-700 hover:underline" onClick={onClear}>
            {t('filters.clear')}
          </button>
        )}
      </div>
      {open && children && <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-2">{children}</div>}
    </div>
  );
}

/** A filter where several options can be on at once (e.g. locations); none on = all. */
export function MultiPick({
  label,
  allLabel,
  options,
  value,
  onChange,
  testId,
}: {
  label: string;
  allLabel: string;
  options: { id: string; name: string }[];
  value: string[];
  onChange: (v: string[]) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const picked = options.filter((o) => value.includes(o.id));
  const summary = picked.length === 0 ? allLabel : picked.length === 1 ? picked[0]!.name : `${picked.length}`;
  return (
    <div className="relative" ref={box}>
      <button type="button" className={`${FILTER_CTRL} max-w-[16rem] truncate text-left`} aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid={testId}>
        {label}: {summary} ▾
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 min-w-[12rem] rounded-lg border border-slate-200 bg-white p-1 shadow-lg" data-testid={testId ? `${testId}-menu` : undefined}>
          <button type="button" className={`block w-full rounded px-2 py-1 text-left text-sm hover:bg-slate-50 ${value.length === 0 ? 'font-semibold' : ''}`} onClick={() => onChange([])}>
            {allLabel}
          </button>
          {options.map((o) => (
            <label key={o.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-50">
              <input type="checkbox" checked={value.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} />
              {o.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
