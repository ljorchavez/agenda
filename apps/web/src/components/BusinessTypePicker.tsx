import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BUSINESS_CATEGORIES, CATEGORY_TYPES, businessCategory, type BusinessCategory, type BusinessType } from '@agenda/shared';
import { CATEGORY_STYLE } from '../pages/Directory';

/** Giro of the business: first the category (same as the directory), then the specific giro. */
export function BusinessTypePicker({ value, onChange, disabled, id }: { value: BusinessType; onChange: (t: BusinessType) => void; disabled?: boolean; id?: string }) {
  const { t } = useTranslation();
  const [cat, setCat] = useState<BusinessCategory>(businessCategory(value));
  const types = CATEGORY_TYPES[cat];
  const pickCat = (c: BusinessCategory) => {
    setCat(c);
    // A category with one giro picks it right away; otherwise keep the giro if it fits.
    const list = CATEGORY_TYPES[c];
    if (list.length === 1 || !list.includes(value)) onChange(list[0]!);
  };
  return (
    <div className="space-y-2" id={id} data-testid="business-type-picker">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('auth.businessCategory')}>
        {BUSINESS_CATEGORIES.map((c) => {
          const on = c === cat;
          return (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => pickCat(c)}
              data-testid={`pick-category-${c}`}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${on ? 'text-white' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'}`}
              style={on ? { background: CATEGORY_STYLE[c].color, borderColor: CATEGORY_STYLE[c].color } : undefined}
            >
              <span className="text-base leading-none" aria-hidden>{CATEGORY_STYLE[c].icon}</span>
              {t(`categories.${c}`)}
            </button>
          );
        })}
      </div>
      {types.length > 1 && (
        <div className="flex flex-wrap gap-1.5 border-t border-slate-100 pt-2" role="radiogroup" aria-label={t('auth.businessType')}>
          {types.map((b) => (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={value === b}
              disabled={disabled}
              onClick={() => onChange(b)}
              data-testid={`pick-type-${b}`}
              className={`rounded-full border px-3 py-1 text-sm disabled:opacity-60 ${value === b ? 'border-brand-600 bg-brand-50 font-medium text-brand-800' : 'border-slate-200 text-slate-600 hover:border-slate-400'}`}
            >
              {t(`businessTypes.${b}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
