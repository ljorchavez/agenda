import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { PublicReviewDto, ReviewRequestDto } from '@agenda/shared';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';
import { ErrorText, Loading } from '../components/ui';
import { Stars } from '../components/Reviews';

/** /r/:token — the customer rates a completed visit (once). */
export function ReviewPage() {
  const { token = '' } = useParams();
  const { t } = useTranslation();
  const req = useQuery({ queryKey: ['review-req', token], queryFn: () => api<ReviewRequestDto>(`/public/reviews/${token}`), retry: false });
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const send = useMutation({
    mutationFn: () => api<PublicReviewDto>(`/public/reviews/${token}`, { method: 'POST', body: { rating, comment: comment || null } }),
  });
  const done = send.data ?? req.data?.review ?? null;
  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 to-slate-100 px-4 py-10">
      <div className="card mx-auto max-w-md space-y-4">
        {req.isLoading ? <Loading /> : !req.data ? (
          <p className="text-center text-slate-600">{t('reviews.badLink')}</p>
        ) : (
          <>
            <div className="text-center">
              <h1 className="text-xl font-semibold">{req.data.businessName}</h1>
              <p className="text-sm text-slate-500">{req.data.serviceName} · {dateTime(req.data.startsAt)}</p>
            </div>
            {done ? (
              <div className="text-center" data-testid="review-done">
                <p className="text-lg">🙏 {t('reviews.thanks')}</p>
                <Stars value={done.rating} size="text-2xl" />
                {done.comment && <p className="mt-2 text-slate-700">“{done.comment}”</p>}
              </div>
            ) : req.data.notYet ? (
              <p className="text-center text-slate-600">{t('reviews.notYet')}</p>
            ) : (
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (rating) send.mutate(); }}>
                <p className="text-center font-medium">{t('reviews.ask')}</p>
                <div className="flex justify-center gap-1" onMouseLeave={() => setHover(0)}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} type="button" aria-label={`${n}`} className={`text-4xl ${(hover || rating) >= n ? 'text-amber-500' : 'text-slate-300'}`} onMouseEnter={() => setHover(n)} onClick={() => setRating(n)}>★</button>
                  ))}
                </div>
                <textarea className="input" rows={3} maxLength={1000} placeholder={t('reviews.commentPlaceholder')} value={comment} onChange={(e) => setComment(e.target.value)} />
                <ErrorText error={send.error} ns="reviews" />
                <button className="btn-primary w-full" disabled={!rating || send.isPending}>{t('reviews.send')}</button>
                <p className="text-center text-xs text-slate-500">{t('reviews.publicNote')}</p>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
