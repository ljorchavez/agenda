import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CalendarFeedDto } from '@agenda/shared';
import { api } from '../lib/api';
import { ErrorText } from './ui';

/** Secret iCal links to see the agenda in Google Calendar or on the iPhone (one way). */
export function CalendarLinksSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const feeds = useQuery({ queryKey: ['calendar-feeds'], queryFn: () => api<CalendarFeedDto[]>('/calendar-feeds') });
  const [copied, setCopied] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const regen = useMutation({
    mutationFn: (f: CalendarFeedDto) => api('/calendar-feeds/regenerate', { method: 'POST', body: { scope: f.scope, locationId: f.locationId, resourceId: f.resourceId } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['calendar-feeds'] }),
  });
  if (feeds.data && !feeds.data.length) return null;
  return (
    <section className="card space-y-3" data-testid="calendar-links">
      <div>
        <h2 className="font-semibold">📅 {t('calendar.title')}</h2>
        <p className="text-sm text-slate-500">{t('calendar.help')}</p>
      </div>
      <ul className="space-y-2">
        {(feeds.data ?? []).map((f) => {
          const key = `${f.scope}-${f.locationId ?? ''}-${f.resourceId ?? ''}`;
          return (
            <li key={key} className="rounded-lg border border-slate-200 p-2 text-sm">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-medium">{t(`calendar.scope.${f.scope}`)}: {f.label}</span>
                <button type="button" className="text-xs text-rose-700 hover:underline" onClick={() => window.confirm(t('calendar.regenConfirm')) && regen.mutate(f)}>{t('calendar.regenerate')}</button>
              </div>
              <div className="flex gap-2">
                <input readOnly className="input min-w-0 flex-1 !py-1 text-xs" value={f.url} onFocus={(e) => e.target.select()} />
                <button type="button" className="btn-secondary !py-1 text-xs" onClick={() => { void navigator.clipboard?.writeText(f.url); setCopied(key); }}>
                  {copied === key ? t('common.copied') : t('common.copy')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      <button type="button" className="text-sm font-medium text-brand-700 hover:underline" onClick={() => setHelp((h) => !h)}>{t('calendar.how')}</button>
      {help && (
        <div className="space-y-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
          <p><b>Google Calendar:</b> {t('calendar.google')}</p>
          <p><b>iPhone:</b> {t('calendar.iphone')}</p>
          <p className="text-xs text-slate-500">{t('calendar.note')}</p>
        </div>
      )}
      <ErrorText error={regen.error} />
    </section>
  );
}
