import { useTranslation } from 'react-i18next';

/** 1–5 stars. Clicking the current value again clears it. Read-only when `onChange` is missing. */
export function StarRating({ value, onChange, size = 'md' }: { value: number | null; onChange?: (v: number | null) => void; size?: 'sm' | 'md' }) {
  const { t } = useTranslation();
  const cls = size === 'sm' ? 'text-sm' : 'text-2xl';
  return (
    <span className={`inline-flex ${onChange ? 'gap-1' : 'gap-0.5'}`} role={onChange ? 'radiogroup' : 'img'} aria-label={t('rating.label', { value: value ?? 0 })}>
      {[1, 2, 3, 4, 5].map((n) => {
        const on = value != null && n <= Math.round(value);
        const star = <span className={`${cls} leading-none ${on ? 'text-amber-400' : 'text-slate-300'}`}>★</span>;
        return onChange ? (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={t('rating.stars', { count: n })}
            className="rounded hover:scale-110 focus:outline-none focus:ring-2 focus:ring-brand-500"
            onClick={() => onChange(value === n ? null : n)}
          >
            {star}
          </button>
        ) : (
          <span key={n}>{star}</span>
        );
      })}
    </span>
  );
}
