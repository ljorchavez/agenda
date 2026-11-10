import { useState } from 'react';

export type SortDir = 'asc' | 'desc';
export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

/**
 * Click a header to sort by it; click again to flip. Each column has its natural first direction
 * (names A→Z, money and dates newest/highest first).
 */
export function useSort<K extends string>(initial: SortState<K>, firstDir: Partial<Record<K, SortDir>> = {}) {
  const [sort, setSort] = useState(initial);
  const toggle = (key: K) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: firstDir[key] ?? 'asc' }));
  return { sort, toggle };
}

const collator = new Intl.Collator('es', { sensitivity: 'base', numeric: true });

/** Sorted copy. Strings follow Spanish order (Ángel next to Andrea); empty values always go last. */
export function sortRows<T>(rows: T[], get: (row: T) => string | number | null | undefined, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    const xe = x == null || x === '';
    const ye = y == null || y === '';
    if (xe || ye) return xe === ye ? 0 : xe ? 1 : -1;
    return sign * (typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y)));
  });
}

/** Header cell that sorts its column; announces the order to screen readers. */
export function SortTh<K extends string>({
  label,
  k,
  sort,
  onSort,
  align = 'left',
  className = '',
}: {
  label: string;
  k: K;
  sort: SortState<K>;
  onSort: (k: K) => void;
  align?: 'left' | 'right';
  className?: string;
}) {
  const active = sort.key === k;
  return (
    <th
      className={`px-4 py-3 font-medium ${align === 'right' ? 'text-right' : ''} ${className}`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 rounded hover:text-slate-900 ${align === 'right' ? 'flex-row-reverse' : ''} ${active ? 'text-slate-900' : ''}`}
      >
        {label}
        <span aria-hidden className={`text-[10px] ${active ? 'opacity-100' : 'opacity-30'}`}>{active && sort.dir === 'desc' ? '▼' : '▲'}</span>
      </button>
    </th>
  );
}
