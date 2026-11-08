import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { addDays, format } from 'date-fns';
import type { PublicBusinessDto } from '@agenda/shared';
import { LanguageSwitch } from '../components/Layout';
import { ErrorText, Loading } from '../components/ui';
import { api } from '../lib/api';
import { dateLocale, dateTime, money } from '../lib/format';

/** Public page where end customers book by themselves: /b/:slug */
export function BookingPage() {
  const { slug = '' } = useParams();
  const { t, i18n } = useTranslation();
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [slot, setSlot] = useState('');
  const [form, setForm] = useState({ name: '', phone: '', email: '' });

  const biz = useQuery({
    queryKey: ['public', slug],
    queryFn: () => api<PublicBusinessDto>(`/public/${slug}`),
    retry: false,
  });

  // Use the business language on first visit if the visitor hasn't chosen one.
  useEffect(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem('agenda.lang'); } catch { /* ignore */ }
    if (biz.data && !stored) void i18n.changeLanguage(biz.data.locale);
  }, [biz.data, i18n]);

  const slots = useQuery({
    queryKey: ['slots', slug, serviceId, date],
    queryFn: () => api<{ slots: string[] }>(`/public/${slug}/availability?serviceId=${serviceId}&date=${date}`),
    enabled: Boolean(serviceId && date),
  });

  const book = useMutation({
    mutationFn: () =>
      api<{ startsAt: string; serviceName: string }>(`/public/${slug}/bookings`, {
        method: 'POST',
        body: { serviceId, startsAt: slot, ...form, email: form.email || undefined },
      }),
    onError: () => {
      setSlot('');
      void slots.refetch();
    },
  });

  const days = useMemo(() => {
    const open = biz.data?.hours.days ?? [];
    return Array.from({ length: 21 }, (_, i) => addDays(new Date(), i)).filter((d) => open.includes(((d.getDay() + 6) % 7) + 1));
  }, [biz.data]);

  if (biz.isLoading) return <Loading />;
  if (biz.isError || !biz.data)
    return <div className="flex min-h-screen items-center justify-center p-6 text-center text-slate-600">{t('booking.notFound')}</div>;

  const business = biz.data;
  const service = business.services.find((s) => s.id === serviceId);
  const slotFmt = new Intl.DateTimeFormat(i18n.language.startsWith('en') ? 'en-US' : 'es-MX', {
    timeStyle: 'short',
    timeZone: business.timezone,
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 to-slate-100 px-4 py-8">
      <div className="mx-auto max-w-xl">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">{biz.data.name}</h1>
            <p className="text-slate-600">{t('booking.title')}</p>
          </div>
          <LanguageSwitch />
        </div>

        {book.isSuccess ? (
          <div className="card text-center">
            <div className="mb-2 text-4xl">✓</div>
            <h2 className="text-xl font-semibold">{t('booking.success')}</h2>
            <p className="mt-2 text-slate-600">
              {t('booking.successDetail', { service: book.data.serviceName, date: dateTime(book.data.startsAt, biz.data.timezone) })}
            </p>
            <button className="btn-secondary mt-6" onClick={() => { book.reset(); setSlot(''); }}>{t('booking.another')}</button>
          </div>
        ) : (
          <div className="card space-y-6">
            <section>
              <h2 className="mb-2 font-semibold">{t('booking.chooseService')}</h2>
              <div className="grid gap-2">
                {biz.data.services.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => { setServiceId(s.id); setSlot(''); }}
                    className={`flex justify-between rounded-lg border p-3 text-left text-sm ${serviceId === s.id ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:border-slate-400'}`}
                  >
                    <span className="font-medium">{s.name}</span>
                    <span className="text-slate-600">{s.durationMin} {t('common.minutes')} · {money(s.priceCents)}</span>
                  </button>
                ))}
              </div>
            </section>

            {service && (
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
            )}

            {service && (
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
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); book.mutate(); }}>
                <h2 className="font-semibold">{t('booking.yourData')}</h2>
                <input required minLength={2} placeholder={t('customers.name')} className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                <input required type="tel" placeholder={t('customers.phone')} className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                <input type="email" placeholder={`${t('customers.email')} (${t('common.optional')})`} className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                <button className="btn-primary w-full" disabled={book.isPending}>{t('booking.confirm')}</button>
              </form>
            )}
            <ErrorText error={book.error} ns="booking" />
          </div>
        )}
      </div>
    </div>
  );
}
