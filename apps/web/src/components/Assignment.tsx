import { useTranslation } from 'react-i18next';
import { ASSIGNMENT_STRATEGIES, type AssignmentSettings, type BusinessKind } from '@agenda/shared';
import { money } from '../lib/format';
import { useResources } from '../lib/queries';

/**
 * Configuración → Reservas: who gets a booking made with "Cualquiera disponible".
 * Least used (default), the cheapest free one, or the business's favorites in order.
 */
export function AssignmentSettingsSection({ value, onChange, disabled, kind }: { value: AssignmentSettings; onChange: (v: AssignmentSettings) => void; disabled: boolean; kind: BusinessKind }) {
  const { t } = useTranslation();
  const resources = useResources();
  const active = (resources.data ?? []).filter((r) => r.active);
  if (active.length < 2) return null;
  // Favorites first in their order, then the rest by name.
  const ordered = [
    ...value.preferredIds.map((id) => active.find((r) => r.id === id)).filter((r): r is NonNullable<typeof r> => Boolean(r)),
    ...active.filter((r) => !value.preferredIds.includes(r.id)),
  ];
  const ids = ordered.map((r) => r.id);
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange({ ...value, preferredIds: next });
  };
  return (
    <div className="space-y-2" data-testid="assignment-settings">
      <h2 className="pt-2 font-semibold">{t('assignment.title')}</h2>
      <p className="text-sm text-slate-500">{t('assignment.help', { what: t(`kinds.${kind}.resource`).toLowerCase() })}</p>
      <div className="space-y-1.5">
        {ASSIGNMENT_STRATEGIES.map((s) => (
          <label key={s} className="flex items-start gap-2 text-sm">
            <input type="radio" name="assign-strategy" disabled={disabled} checked={value.strategy === s} onChange={() => onChange({ strategy: s, preferredIds: s === 'preferred' && !value.preferredIds.length ? ids : value.preferredIds })} className="mt-0.5" />
            <span>
              {t(`assignment.${s}`)}
              <span className="block text-xs text-slate-500">{t(`assignment.${s}Help`)}</span>
            </span>
          </label>
        ))}
      </div>
      {value.strategy === 'preferred' && (
        <ol className="max-w-md divide-y divide-slate-100 rounded-lg border border-slate-200" data-testid="preferred-order">
          {ordered.map((r, i) => (
            <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
              <span>
                <span className="mr-2 text-xs text-slate-400">{i + 1}.</span>
                {r.name}
                {r.pricePerHourCents != null && <span className="ml-1 text-xs text-slate-500">· {t('resources.perHour', { price: money(r.pricePerHourCents) })}</span>}
              </span>
              {!disabled && (
                <span className="flex gap-2 text-slate-500">
                  <button type="button" aria-label={t('forms.up')} disabled={i === 0} onClick={() => move(i, -1)} className="hover:text-slate-900 disabled:opacity-30">↑</button>
                  <button type="button" aria-label={t('forms.down')} disabled={i === ordered.length - 1} onClick={() => move(i, 1)} className="hover:text-slate-900 disabled:opacity-30">↓</button>
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
