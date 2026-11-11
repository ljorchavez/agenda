import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Saves by itself a moment after the person stops changing things (no "Guardar" button).
 * `key` is anything that changes when there is something new to save; the first value is
 * what's already saved, so it doesn't save on load.
 */
export function useAutoSave(key: unknown, save: () => Promise<unknown>, opts: { enabled?: boolean; delay?: number; valid?: boolean } = {}) {
  const { enabled = true, delay = 700, valid = true } = opts;
  const [state, setState] = useState<SaveState>('idle');
  const first = useRef(true);
  const fn = useRef(save);
  fn.current = save;
  const serialized = JSON.stringify(key);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!enabled || !valid) return;
    const id = window.setTimeout(() => {
      setState('saving');
      fn.current().then(
        () => setState('saved'),
        () => setState('error'),
      );
    }, delay);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized, enabled, valid]);
  useEffect(() => {
    if (state !== 'saved') return;
    const id = window.setTimeout(() => setState('idle'), 2500);
    return () => window.clearTimeout(id);
  }, [state]);
  return state;
}

/** "Guardando…" / "✓ Guardado" next to what is being saved. */
export function SaveStatus({ state, className = '', floating }: { state: SaveState; className?: string; floating?: boolean }) {
  const { t } = useTranslation();
  if (floating && state === 'idle') return <span aria-live="polite" data-testid="save-status" />;
  return (
    <span
      className={`text-xs ${floating ? 'fixed bottom-20 right-4 z-40 rounded-full border border-slate-200 bg-white px-3 py-1.5 shadow-md md:bottom-6' : ''} ${className}`}
      aria-live="polite"
      data-testid="save-status"
    >
      {state === 'saving' && <span className="text-slate-500">{t('common.saving')}</span>}
      {state === 'saved' && <span className="text-emerald-700">✓ {t('common.saved')}</span>}
      {state === 'error' && <span className="text-rose-700">{t('common.saveError')}</span>}
    </span>
  );
}
