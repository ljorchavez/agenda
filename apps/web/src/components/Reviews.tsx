import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReviewDto, ReviewSummaryDto } from '@agenda/shared';
import { api } from '../lib/api';
import { useAccess } from '../lib/auth';
import { dateOnly } from '../lib/format';
import { ErrorText } from './ui';

export function Stars({ value, size = 'text-sm' }: { value: number; size?: string }) {
  return (
    <span className={`${size} tracking-tight text-amber-500`} aria-label={`${value} / 5`}>
      {'★★★★★'.slice(0, Math.round(value))}
      <span className="text-slate-300">{'★★★★★'.slice(Math.round(value))}</span>
    </span>
  );
}

/** "★ 4.8 (23)" */
export function RatingBadge({ average, count }: { average: number | null; count: number }) {
  const { t } = useTranslation();
  if (!count || average == null) return null;
  return (
    <span className="inline-flex items-center gap-1 text-sm" data-testid="rating-badge">
      <span className="text-amber-500">★</span>
      <b>{average.toFixed(1)}</b>
      <span className="text-slate-500">({t('reviews.count', { count })})</span>
    </span>
  );
}

/**
 * Booking page, after booking and the shop (like Fresha or Booksy: the rating sits next to the
 * name and the reviews further down): average, count and the latest ones, two at first.
 */
export function PublicReviews({ summary }: { summary: ReviewSummaryDto }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  if (!summary.count || summary.average == null) return null;
  const shown = all ? summary.recent : summary.recent.slice(0, 2);
  return (
    <section id="resenas" className="card mt-4 scroll-mt-4 space-y-3" data-testid="public-reviews">
      <div className="flex items-center gap-4">
        <div className="text-center">
          <div className="text-3xl font-bold text-slate-900">{summary.average.toFixed(1)}</div>
          <Stars value={Math.round(summary.average)} size="text-sm" />
        </div>
        <div>
          <h2 className="font-semibold">{t('reviews.title')}</h2>
          <p className="text-sm text-slate-500">{t('reviews.count', { count: summary.count })} · ✓ {t('reviews.verifiedAll')}</p>
        </div>
      </div>
      <ul className="space-y-2">
        {shown.map((r, i) => (
          <li key={i} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">{r.authorName}</span>
              <Stars value={r.rating} size="text-xs" />
            </div>
            {r.comment && <p className="mt-1 text-slate-700">{r.comment}</p>}
            {r.reply && <p className="mt-1 border-l-2 border-brand-300 pl-2 text-xs text-slate-600"><b>{t('reviews.reply')}:</b> {r.reply}</p>}
            <p className="mt-1 text-[11px] text-slate-400">{dateOnly(r.createdAt)}</p>
          </li>
        ))}
      </ul>
      {!all && summary.recent.length > 2 && (
        <button type="button" className="text-sm font-medium text-brand-700 hover:underline" onClick={() => setAll(true)}>
          {t('reviews.showMore')}
        </button>
      )}
    </section>
  );
}

/** Configuración → Reseñas: read, reply in public and hide offensive ones (never edit). */
export function ReviewsSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { manager } = useAccess();
  const data = useQuery({ queryKey: ['reviews'], queryFn: () => api<{ items: ReviewDto[]; average: number | null; count: number }>('/reviews') });
  const [replying, setReplying] = useState<{ id: string; text: string } | null>(null);
  const mod = useMutation({
    mutationFn: ({ id, ...body }: { id: string; reply?: string | null; hidden?: boolean }) => api(`/reviews/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setReplying(null);
      void qc.invalidateQueries({ queryKey: ['reviews'] });
    },
  });
  const d = data.data;
  return (
    <section className="card space-y-3" data-testid="reviews-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">⭐ {t('reviews.title')}</h2>
          <p className="text-sm text-slate-500">{t('reviews.help')}</p>
        </div>
        {d && <RatingBadge average={d.average} count={d.count} />}
      </div>
      <ul className="space-y-2">
        {(d?.items ?? []).map((r) => (
          <li key={r.id} className={`rounded-lg border p-3 text-sm ${r.hidden ? 'border-dashed border-slate-300 opacity-60' : 'border-slate-200'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span><b>{r.authorName}</b> <Stars value={r.rating} /></span>
              <span className="text-xs text-slate-500">{[r.serviceName, r.locationName, dateOnly(r.createdAt)].filter(Boolean).join(' · ')}</span>
            </div>
            {r.comment && <p className="mt-1">{r.comment}</p>}
            {r.reply && replying?.id !== r.id && <p className="mt-1 border-l-2 border-brand-300 pl-2 text-xs text-slate-600"><b>{t('reviews.reply')}:</b> {r.reply}</p>}
            {replying?.id === r.id ? (
              <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); mod.mutate({ id: r.id, reply: replying.text || null }); }}>
                <input className="input" autoFocus value={replying.text} onChange={(e) => setReplying({ id: r.id, text: e.target.value })} placeholder={t('reviews.replyPlaceholder')} />
                <button className="btn-primary">{t('reviews.publishReply')}</button>
              </form>
            ) : manager && (
              <div className="mt-2 flex gap-3 text-xs">
                <button type="button" className="text-brand-700 hover:underline" onClick={() => setReplying({ id: r.id, text: r.reply ?? '' })}>{r.reply ? t('reviews.editReply') : t('reviews.doReply')}</button>
                <button type="button" className="text-slate-600 hover:underline" onClick={() => mod.mutate({ id: r.id, hidden: !r.hidden })}>{r.hidden ? t('reviews.show') : t('reviews.hide')}</button>
              </div>
            )}
          </li>
        ))}
        {d?.items.length === 0 && <li className="text-sm text-slate-500">{t('reviews.none')}</li>}
      </ul>
      <ErrorText error={mod.error} />
    </section>
  );
}
