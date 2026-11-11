import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, format } from 'date-fns';
import { kindConfig, type ManageAppointmentDto } from '@agenda/shared';
import { LanguageSwitch } from '../components/Layout';
import { ErrorText, Loading, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { dateLocale, dateTime } from '../lib/format';

/** Public page where a customer reschedules or cancels their own appointment: /c/:token */
export function ManagePage() {
  const { token = '' } = useParams();
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'view' | 'reschedule' | 'confirmCancel'>('view');
  const [date, setDate] = useState('');
  const [slot, setSlot] = useState('');
  const [done, setDone] = useState<null | 'rescheduled' | 'cancelled'>(null);

  const key = ['manage', token];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<ManageAppointmentDto>(`/public/manage/${encodeURIComponent(token)}`),
    retry: false,
  });

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem('agenda.lang');
    } catch {
      /* ignore */
    }
    if (q.data && !stored) void i18n.changeLanguage(q.data.business.locale);
  }, [q.data, i18n]);

  const days = useMemo(() => {
    const open = q.data?.business.hours.days ?? [];
    const all = Array.from({ length: 28 }, (_, i) => addDays(new Date(), i));
    // Classes can be scheduled any day; other kinds follow opening days.
    return q.data && kindConfig(q.data.business.kind).sessions ? all : all.filter((d) => open.includes(((d.getDay() + 6) % 7) + 1));
  }, [q.data]);

  const slots = useQuery({
    queryKey: ['manage-slots', token, date],
    queryFn: () => api<{ slots: string[] }>(`/public/manage/${encodeURIComponent(token)}/availability?date=${date}`),
    enabled: mode === 'reschedule' && Boolean(date),
  });

  const reschedule = useMutation({
    mutationFn: () => api<ManageAppointmentDto>(`/public/manage/${encodeURIComponent(token)}/reschedule`, { method: 'POST', body: { startsAt: slot } }),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      setDone('rescheduled');
      setMode('view');
      setSlot('');
    },
    onError: () => {
      setSlot('');
      void slots.refetch();
    },
  });
  const cancel = useMutation({
    mutationFn: () => api<ManageAppointmentDto>(`/public/manage/${encodeURIComponent(token)}/cancel`, { method: 'POST' }),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      setDone('cancelled');
      setMode('view');
    },
  });

  if (q.isLoading) return <Loading />;
  if (q.isError || !q.data)
    return <div className="flex min-h-screen items-center justify-center p-6 text-center text-slate-600">{t('manage.notFound')}</div>;

  const { business, appointment: a } = q.data;
  const tz = business.timezone;
  const slotFmt = new Intl.DateTimeFormat(i18n.language.startsWith('en') ? 'en-US' : 'es-MX', { timeStyle: 'short', timeZone: tz });

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 to-slate-100 px-4 py-8">
      <div className="mx-auto max-w-xl">
        <div className="mb-6 flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{business.name}</h1>
            <p className="text-slate-600">{t('manage.title')}</p>
          </div>
          <LanguageSwitch />
        </div>

        <div className="card space-y-5">
          {done && (
            <div className={`rounded-lg p-3 text-sm ${done === 'cancelled' ? 'bg-rose-50 text-rose-800' : 'bg-emerald-50 text-emerald-800'}`}>
              {t(`manage.done.${done}`)}
            </div>
          )}

          <div>
            <p className="text-sm text-slate-500">{t('manage.hello', { name: a.customerFirstName })}</p>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-semibold text-slate-900">
                  {[
                    !kindConfig(business.kind).partySize && !kindConfig(business.kind).durations && a.serviceName,
                    a.partySize != null && (a.partySize > 1 || kindConfig(business.kind).partySize) && t('booking.people', { count: a.partySize }),
                  ].filter(Boolean).join(' · ') || a.serviceName}
                </div>
                {a.resourceName && <div className="text-sm text-slate-600">{t('manage.with', { name: a.resourceName })}</div>}
                <div className="text-slate-700">{dateTime(a.startsAt, tz)}</div>
              </div>
              <StatusBadge status={a.status} />
            </div>
          </div>

          {q.data.plans.length > 0 && (
            <ul className="space-y-1 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900" data-testid="manage-plans">
              {q.data.plans.map((p) => (
                <li key={p.name}>🎟️ {p.sessionsLeft == null ? t('sales.publicUnlimited', { name: p.name }) : t('sales.publicLeft', { count: p.sessionsLeft, name: p.name })}{p.expiresOn ? ` · ${t('sales.expires', { date: p.expiresOn })}` : ''}</li>
              ))}
            </ul>
          )}

          {q.data.reviewPath && (
            <a href={q.data.reviewPath} className="block rounded-lg border border-amber-200 bg-amber-50 p-3 text-center text-sm font-medium text-amber-900 hover:bg-amber-100" data-testid="review-link">
              ⭐ {q.data.reviewed ? t('reviews.seeYours') : t('reviews.leave')}
            </a>
          )}

          {q.data.reason && q.data.reason !== 'not_active' && q.data.reason !== 'past' && (
            <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
              {t(`manage.reason.${q.data.reason}`, { hours: q.data.minHoursNotice })}
              {business.phone && (
                <>
                  {' '}
                  <a className="font-medium underline" href={`https://wa.me/${business.phone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">
                    {t('manage.contact')}
                  </a>
                </>
              )}
            </p>
          )}

          {mode === 'view' && (q.data.canReschedule || q.data.canCancel) && (
            <>
              {q.data.changeDeadline && (
                <p className="text-xs text-slate-500">{t('manage.deadline', { date: dateTime(q.data.changeDeadline, tz) })}</p>
              )}
              <div className="flex flex-col gap-2 sm:flex-row">
                {q.data.canReschedule && (
                  <button className="btn-primary flex-1" onClick={() => { setMode('reschedule'); setDone(null); }}>
                    {t('manage.reschedule')}
                  </button>
                )}
                {q.data.canCancel && (
                  <button className="btn-secondary flex-1 text-rose-700" onClick={() => { setMode('confirmCancel'); setDone(null); }}>
                    {t('manage.cancel')}
                  </button>
                )}
              </div>
            </>
          )}

          {mode === 'confirmCancel' && (
            <div className="space-y-3">
              <p className="text-sm text-slate-700">{t('manage.cancelConfirm')}</p>
              <div className="flex gap-2">
                <button className="btn-secondary flex-1" onClick={() => setMode('view')}>{t('common.back')}</button>
                <button className="btn-primary flex-1 !bg-rose-600" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
                  {t('manage.cancelYes')}
                </button>
              </div>
              <ErrorText error={cancel.error} ns="manage" />
            </div>
          )}

          {mode === 'reschedule' && (
            <div className="space-y-5">
              <section>
                <h2 className="mb-2 font-semibold">{t('booking.chooseDate')}</h2>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {days.map((d) => {
                    const v = format(d, 'yyyy-MM-dd');
                    return (
                      <button
                        key={v}
                        onClick={() => { setDate(v); setSlot(''); }}
                        className={`min-w-16 rounded-lg border px-2 py-2 text-center text-sm ${date === v ? 'border-brand-600 bg-brand-50' : 'border-slate-200'}`}
                      >
                        <div className="text-xs capitalize text-slate-500">{format(d, 'EEE', { locale: dateLocale() })}</div>
                        <div className="font-semibold">{format(d, 'd')}</div>
                        <div className="text-xs capitalize text-slate-500">{format(d, 'MMM', { locale: dateLocale() })}</div>
                      </button>
                    );
                  })}
                </div>
              </section>
              {date && (
                <section>
                  <h2 className="mb-2 font-semibold">{t('booking.chooseTime')}</h2>
                  {slots.isLoading ? (
                    <Loading />
                  ) : !slots.data?.slots.length ? (
                    <p className="text-sm text-slate-500">{t('booking.noSlots')}</p>
                  ) : (
                    <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
                      {slots.data.slots.map((s) => (
                        <button
                          key={s}
                          onClick={() => setSlot(s)}
                          className={`rounded-lg border py-2 text-sm ${slot === s ? 'border-brand-600 bg-brand-700 text-white' : 'border-slate-200 hover:border-slate-400'}`}
                        >
                          {slotFmt.format(new Date(s))}
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              )}
              {slot && (
                <p className="rounded-lg bg-slate-50 p-3 text-sm">
                  {t('manage.newTime')}: <b>{dateTime(slot, tz)}</b>
                </p>
              )}
              <div className="flex gap-2">
                <button className="btn-secondary flex-1" onClick={() => { setMode('view'); setSlot(''); }}>{t('common.back')}</button>
                <button className="btn-primary flex-1" disabled={!slot || reschedule.isPending} onClick={() => reschedule.mutate()}>
                  {t('manage.confirmReschedule')}
                </button>
              </div>
              <ErrorText error={reschedule.error} ns="manage" />
            </div>
          )}

          {(a.status === 'cancelled' || done === 'cancelled') && (
            <Link to={`/b/${business.slug}`} className="btn-secondary w-full">{t('manage.bookAgain')}</Link>
          )}
        </div>
      </div>
    </div>
  );
}
