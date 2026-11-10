import { useTranslation } from 'react-i18next';
import type { HoursBreak } from '@agenda/shared';
import { useIntlLocale } from '../lib/format';

/** The part of a schedule this editor touches (business, location and resource hours share it). */
export interface HoursValue {
  days: number[];
  open: string;
  close: string;
  breaks?: HoursBreak[];
}

export function useDayName() {
  const intl = useIntlLocale();
  // 2024-01-01 was a Monday, so day n of January 2024 is ISO weekday n.
  return (n: number) => new Intl.DateTimeFormat(intl, { weekday: 'short' }).format(new Date(2024, 0, n));
}

/** "Lun–Sáb 8:00–14:00, 16:00–18:00" for cards and lists. */
export function useHoursSummary() {
  const dayName = useDayName();
  return (h: HoursValue) => {
    const days = [...h.days].sort();
    const consecutive = days.every((d, i) => i === 0 || d === days[i - 1]! + 1);
    const dayText = consecutive && days.length > 2 ? `${dayName(days[0]!)}–${dayName(days[days.length - 1]!)}` : days.map(dayName).join(', ');
    const stretches: string[] = [];
    let cursor = h.open;
    for (const b of [...(h.breaks ?? [])].sort((a, b) => a.start.localeCompare(b.start))) {
      stretches.push(`${cursor}–${b.start}`);
      cursor = b.end;
    }
    stretches.push(`${cursor}–${h.close}`);
    return `${dayText} ${stretches.join(', ')}`;
  };
}

/**
 * Days, opening/closing time and breaks ("de 8 a 2 y de 4 a 6" = 8:00–18:00 with a 14:00–16:00 break).
 * `idPrefix` keeps label ids unique when two editors are on one page.
 */
export function HoursFields({
  value,
  onChange,
  disabled,
  idPrefix,
}: {
  value: HoursValue;
  onChange: (v: HoursValue) => void;
  disabled?: boolean;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  const dayName = useDayName();
  const breaks = value.breaks ?? [];
  const setBreak = (i: number, patch: Partial<HoursBreak>) =>
    onChange({ ...value, breaks: breaks.map((b, j) => (j === i ? { ...b, ...patch } : b)) });

  return (
    <div className="space-y-4">
      <div>
        <div className="label">{t('settings.openDays')}</div>
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5, 6, 7].map((d) => {
            const on = value.days.includes(d);
            return (
              <button
                key={d}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                onClick={() => {
                  const days = on ? value.days.filter((x) => x !== d) : [...value.days, d].sort();
                  if (days.length) onChange({ ...value, days });
                }}
                className={`rounded-lg border px-3 py-1.5 text-sm capitalize ${on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 text-slate-500'}`}
              >
                {dayName(d)}
              </button>
            );
          })}
        </div>
      </div>
      <div className="grid max-w-md grid-cols-2 gap-3">
        <div>
          <label className="label" htmlFor={`${idPrefix}-open`}>{t('settings.open')}</label>
          <input id={`${idPrefix}-open`} type="time" disabled={disabled} className="input" value={value.open} onChange={(e) => onChange({ ...value, open: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor={`${idPrefix}-close`}>{t('settings.close')}</label>
          <input id={`${idPrefix}-close`} type="time" disabled={disabled} className="input" value={value.close} onChange={(e) => onChange({ ...value, close: e.target.value })} />
        </div>
      </div>
      <div>
        <div className="label">{t('schedule.breaks')}</div>
        <p className="mb-2 text-xs text-slate-500">{t('schedule.breaksHelp')}</p>
        <div className="space-y-2">
          {breaks.map((b, i) => (
            <div key={i} className="flex max-w-md items-center gap-2">
              <input type="time" disabled={disabled} className="input" aria-label={t('schedule.breakFrom')} value={b.start} onChange={(e) => setBreak(i, { start: e.target.value })} />
              <span className="text-slate-400">–</span>
              <input type="time" disabled={disabled} className="input" aria-label={t('schedule.breakTo')} value={b.end} onChange={(e) => setBreak(i, { end: e.target.value })} />
              {!disabled && (
                <button type="button" className="px-2 text-lg text-slate-400 hover:text-rose-600" aria-label={t('common.delete')} onClick={() => onChange({ ...value, breaks: breaks.filter((_, j) => j !== i) })}>
                  ×
                </button>
              )}
            </div>
          ))}
          {!disabled && breaks.length < 4 && (
            <button type="button" className="text-sm font-medium text-brand-700 hover:underline" onClick={() => onChange({ ...value, breaks: [...breaks, { start: '14:00', end: '16:00' }] })}>
              + {t('schedule.addBreak')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
