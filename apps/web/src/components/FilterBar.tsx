import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/** Small control style shared by every filter bar. */
export const FILTER_CTRL = 'input !w-auto !py-1 !px-2 !text-sm';

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
            className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-medium ${active ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}
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
