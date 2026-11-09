import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { addDays, format } from 'date-fns';
import {
  eligibleProfessionals,
  spacePriceCents,
  type PublicBookingResult,
  type PublicBusinessDto,
  type PublicClassSessionDto,
} from '@agenda/shared';
import { LanguageSwitch } from '../components/Layout';
import { ErrorText, Loading } from '../components/ui';
import { api } from '../lib/api';
import { dateLocale, dateTime, money } from '../lib/format';

type Book = (body: Record<string, unknown>) => void;
type FlowProps = { business: PublicBusinessDto; onBook: Book; pending: boolean; error: unknown; resetKey: number };

/** Public page where end customers book by themselves: /b/:slug */
export function BookingPage() {
  const { slug = '' } = useParams();
  const { t, i18n } = useTranslation();
  const [resetKey, setResetKey] = useState(0);

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

  const book = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<PublicBookingResult>(`/public/${slug}/bookings`, { method: 'POST', body }),
    onError: () => setResetKey((k) => k + 1),
  });

  if (biz.isLoading) return <Loading />;
  if (biz.isError || !biz.data)
    return <div className="flex min-h-screen items-center justify-center p-6 text-center text-slate-600">{t('booking.notFound')}</div>;

  const business = biz.data;
  const mapsUrl =
    business.lat != null
      ? `https://www.google.com/maps/search/?api=1&query=${business.lat},${business.lng}`
      : business.address
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([business.address, business.neighborhood, business.city].filter(Boolean).join(', '))}`
        : null;
  const subtitle = {
    reservations: t('booking.titleTable'),
    classes: t('booking.titleClasses'),
    rentals: t('booking.titleRentals'),
    appointments: t('booking.title'),
  }[business.kind];
  const flowProps: FlowProps = { business, onBook: (b) => book.mutate(b), pending: book.isPending, error: book.error, resetKey };

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 to-slate-100 px-4 py-8">
      <div className="mx-auto max-w-xl">
        <div className="mb-6 flex items-start justify-between">
          <div>
            <Link to="/directorio" className="text-xs text-slate-500 hover:text-brand-700">← {t('directory.title')}</Link>
            <h1 className="text-2xl font-bold text-slate-900">{business.name}</h1>
            <p className="text-slate-600">{subtitle}</p>
            {business.description && <p className="mt-2 max-w-md text-sm text-slate-600">{business.description}</p>}
            {(business.address || business.neighborhood) && (
              <p className="mt-1 text-sm text-slate-500">
                {[business.address, business.neighborhood, business.city].filter(Boolean).join(', ')}
                {mapsUrl && (
                  <>
                    {' · '}
                    <a href={mapsUrl} target="_blank" rel="noreferrer" className="font-medium text-brand-700">{t('booking.directions')}</a>
                  </>
                )}
              </p>
            )}
          </div>
          <LanguageSwitch />
        </div>

        {book.isSuccess ? (
          <Success business={business} result={book.data} onAnother={() => book.reset()} />
        ) : (
          <div className="card space-y-6">
            {business.kind === 'reservations' ? (
              <TablesFlow {...flowProps} />
            ) : business.kind === 'classes' ? (
              <ClassesFlow {...flowProps} />
            ) : business.kind === 'rentals' ? (
              <RentalsFlow {...flowProps} />
            ) : (
              <ServicesFlow {...flowProps} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Shared pieces ----------

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Chip({ on, onClick, children, label }: { on: boolean; onClick: () => void; children: ReactNode; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      aria-label={label}
      className={`rounded-lg border px-3 py-2 text-left text-sm ${on ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:border-slate-400'}`}
    >
      {children}
    </button>
  );
}

function useOpenDays(business: PublicBusinessDto, length: number) {
  return useMemo(() => {
    const open = business.hours.days;
    return Array.from({ length }, (_, i) => addDays(new Date(), i)).filter((d) => open.includes(((d.getDay() + 6) % 7) + 1));
  }, [business, length]);
}

function DayPicker({ days, value, onChange, badge }: { days: Date[]; value: string; onChange: (v: string) => void; badge?: (v: string) => ReactNode }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {days.map((d) => {
        const v = format(d, 'yyyy-MM-dd');
        return (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className={`min-w-16 rounded-lg border px-2 py-2 text-center text-sm ${value === v ? 'border-brand-600 bg-brand-50' : 'border-slate-200'}`}
          >
            <div className="text-xs capitalize text-slate-500">{format(d, 'EEE', { locale: dateLocale() })}</div>
            <div className="font-semibold">{format(d, 'd')}</div>
            <div className="text-xs capitalize text-slate-500">{format(d, 'MMM', { locale: dateLocale() })}</div>
            {badge?.(v)}
          </button>
        );
      })}
    </div>
  );
}

function useSlotFormat(tz: string) {
  const { i18n } = useTranslation();
  return new Intl.DateTimeFormat(i18n.language.startsWith('en') ? 'en-US' : 'es-MX', { timeStyle: 'short', timeZone: tz });
}

function SlotGrid({ loading, slots, value, onChange, tz }: { loading: boolean; slots: string[] | undefined; value: string; onChange: (s: string) => void; tz: string }) {
  const { t } = useTranslation();
  const fmt = useSlotFormat(tz);
  if (loading) return <Loading />;
  if (!slots?.length) return <p className="text-sm text-slate-500">{t('booking.noSlots')}</p>;
  return (
    <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
      {slots.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className={`rounded-lg border py-2 text-sm ${value === s ? 'border-brand-600 bg-brand-700 text-white' : 'border-slate-200 hover:border-slate-400'}`}
        >
          {fmt.format(new Date(s))}
        </button>
      ))}
    </div>
  );
}

function CustomerForm({ onSubmit, pending, error, summary, cta }: { onSubmit: (f: { name: string; phone: string; email?: string }) => void; pending: boolean; error: unknown; summary?: ReactNode; cta: string }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSubmit({ ...form, email: form.email || undefined }); }}>
      <h2 className="font-semibold">{t('booking.yourData')}</h2>
      {summary}
      <input required minLength={2} placeholder={t('customers.name')} className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input required type="tel" placeholder={t('customers.phone')} className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      <input type="email" placeholder={`${t('customers.email')} (${t('common.optional')})`} className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      <button className="btn-primary w-full" disabled={pending}>{cta}</button>
      <ErrorText error={error} ns="booking" />
    </form>
  );
}

/** Clears the chosen time after a failed booking (someone else took it) so fresh slots load. */
function useResetOnError(resetKey: number, clear: () => void) {
  useEffect(() => {
    if (resetKey) clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);
}

// ---------- Services (optionally with a professional) ----------

function ServicesFlow({ business, onBook, pending, error, resetKey }: FlowProps) {
  const { t } = useTranslation();
  const [serviceId, setServiceId] = useState('');
  const [proId, setProId] = useState('');
  const [date, setDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [slot, setSlot] = useState('');
  const days = useOpenDays(business, 21);
  const service = business.services.find((s) => s.id === serviceId);
  const pros = eligibleProfessionals(business.professionals, serviceId || null);
  const slots = useQuery({
    queryKey: ['slots', business.slug, serviceId, proId, date],
    queryFn: () =>
      api<{ slots: string[] }>(`/public/${business.slug}/availability?serviceId=${serviceId}&date=${date}${proId ? `&professionalId=${proId}` : ''}`),
    enabled: Boolean(serviceId && date),
  });
  useResetOnError(resetKey, () => { setSlot(''); void slots.refetch(); });

  return (
    <>
      <Section title={t('booking.chooseService')}>
        <div className="grid gap-2">
          {business.services.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => { setServiceId(s.id); setSlot(''); if (proId && !eligibleProfessionals(business.professionals, s.id).some((p) => p.id === proId)) setProId(''); }}
              className={`flex justify-between rounded-lg border p-3 text-left text-sm ${serviceId === s.id ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:border-slate-400'}`}
            >
              <span className="font-medium">{s.name}</span>
              <span className="text-right text-slate-600">
                {s.durationMin} {t('common.minutes')} · {money(s.priceCents)}
                {business.deposit && s.priceCents > 0 && (
                  <span className="block text-xs text-amber-700">
                    {t('booking.depositOf', {
                      amount: money(business.deposit.type === 'percent' ? Math.round((s.priceCents * business.deposit.value) / 100) : Math.min(business.deposit.value, s.priceCents)),
                    })}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </Section>

      {service && pros.length > 0 && (
        <Section title={t('booking.chooseProfessional')}>
          <div className="flex flex-wrap gap-2">
            <Chip on={!proId} onClick={() => { setProId(''); setSlot(''); }}>{t('booking.anyProfessional')}</Chip>
            {pros.map((p) => (
              <Chip key={p.id} on={proId === p.id} onClick={() => { setProId(p.id); setSlot(''); }}>
                <span className="flex items-center gap-2">
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: p.color }} />
                  {p.name}
                </span>
              </Chip>
            ))}
          </div>
        </Section>
      )}

      {service && (
        <>
          <Section title={t('booking.chooseDate')}>
            <DayPicker days={days} value={date} onChange={(v) => { setDate(v); setSlot(''); }} />
          </Section>
          <Section title={t('booking.chooseTime')}>
            <SlotGrid loading={slots.isLoading} slots={slots.data?.slots} value={slot} onChange={setSlot} tz={business.timezone} />
          </Section>
        </>
      )}

      {slot && service && (
        <CustomerForm
          pending={pending}
          error={error}
          cta={t('booking.confirm')}
          onSubmit={(f) => onBook({ serviceId, professionalId: proId || null, startsAt: slot, ...f })}
        />
      )}
    </>
  );
}

// ---------- Restaurant tables ----------

function TablesFlow({ business, onBook, pending, error, resetKey }: FlowProps) {
  const { t } = useTranslation();
  const [partySize, setPartySize] = useState(2);
  const [date, setDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [slot, setSlot] = useState('');
  const days = useOpenDays(business, 21);
  const slots = useQuery({
    queryKey: ['slots', business.slug, `p${partySize}`, date],
    queryFn: () => api<{ slots: string[] }>(`/public/${business.slug}/availability?partySize=${partySize}&date=${date}`),
    enabled: Boolean(date),
  });
  useResetOnError(resetKey, () => { setSlot(''); void slots.refetch(); });

  return (
    <>
      <Section title={t('booking.choosePeople')}>
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: business.maxPartySize ?? 8 }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => { setPartySize(n); setSlot(''); }}
              className={`h-11 min-w-11 rounded-lg border px-3 text-sm font-medium ${partySize === n ? 'border-brand-600 bg-brand-700 text-white' : 'border-slate-200 hover:border-slate-400'}`}
              aria-pressed={partySize === n}
            >
              {n}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">{t('booking.largerGroups')}</p>
      </Section>
      <Section title={t('booking.chooseDate')}>
        <DayPicker days={days} value={date} onChange={(v) => { setDate(v); setSlot(''); }} />
      </Section>
      <Section title={t('booking.chooseTime')}>
        <SlotGrid loading={slots.isLoading} slots={slots.data?.slots} value={slot} onChange={setSlot} tz={business.timezone} />
      </Section>
      {slot && (
        <CustomerForm pending={pending} error={error} cta={t('booking.confirmTable')} onSubmit={(f) => onBook({ partySize, startsAt: slot, ...f })} />
      )}
    </>
  );
}

// ---------- Group classes ----------

function ClassesFlow({ business, onBook, pending, error, resetKey }: FlowProps) {
  const { t } = useTranslation();
  const fmt = useSlotFormat(business.timezone);
  const classes = useQuery({
    queryKey: ['public-classes', business.slug],
    queryFn: () => api<PublicClassSessionDto[]>(`/public/${business.slug}/classes?days=14`),
  });
  const dayOf = useMemo(() => new Intl.DateTimeFormat('en-CA', { timeZone: business.timezone }), [business.timezone]);
  const byDay = useMemo(() => {
    const m = new Map<string, PublicClassSessionDto[]>();
    for (const c of classes.data ?? []) {
      const k = dayOf.format(new Date(c.startsAt));
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    return m;
  }, [classes.data, dayOf]);
  const days = useMemo(() => Array.from({ length: 14 }, (_, i) => addDays(new Date(), i)).filter((d) => byDay.has(format(d, 'yyyy-MM-dd'))), [byDay]);
  const [date, setDate] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [spots, setSpots] = useState(1);
  const day = date || (days[0] ? format(days[0], 'yyyy-MM-dd') : '');
  const chosen = (classes.data ?? []).find((c) => c.id === sessionId);
  useResetOnError(resetKey, () => { setSessionId(''); void classes.refetch(); });

  if (classes.isLoading) return <Loading />;
  if (!days.length) return <p className="text-sm text-slate-500">{t('booking.noClasses')}</p>;

  return (
    <>
      <Section title={t('booking.chooseDate')}>
        <DayPicker
          days={days}
          value={day}
          onChange={(v) => { setDate(v); setSessionId(''); }}
          badge={(v) => <div className="mt-0.5 text-[10px] font-medium text-brand-700">{t('booking.classesN', { count: byDay.get(v)?.length ?? 0 })}</div>}
        />
      </Section>
      <Section title={t('booking.chooseClass')}>
        <div className="grid gap-2">
          {(byDay.get(day) ?? []).map((c) => {
            const full = c.spotsLeft <= 0;
            return (
              <button
                key={c.id}
                type="button"
                disabled={full}
                onClick={() => { setSessionId(c.id); setSpots(1); }}
                aria-pressed={sessionId === c.id}
                className={`flex items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm ${sessionId === c.id ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:border-slate-400'} ${full ? 'cursor-not-allowed opacity-60' : ''}`}
              >
                <span>
                  <span className="font-semibold">{fmt.format(new Date(c.startsAt))}</span>
                  <span className="text-slate-500"> – {fmt.format(new Date(c.endsAt))}</span>
                  <span className="block font-medium">{c.serviceName}</span>
                  {c.professionalName && <span className="block text-xs text-slate-500">{t('booking.withInstructor', { name: c.professionalName })}</span>}
                </span>
                <span className="text-right">
                  <span className="block text-slate-700">{money(c.priceCents)}</span>
                  <span className={`block text-xs font-medium ${full ? 'text-rose-700' : c.spotsLeft <= 3 ? 'text-amber-700' : 'text-emerald-700'}`}>
                    {full ? t('booking.classFull') : t('booking.spotsLeft', { count: c.spotsLeft })}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </Section>
      {chosen && chosen.spotsLeft > 1 && (
        <Section title={t('booking.howManySpots')}>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: Math.min(5, chosen.spotsLeft) }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setSpots(n)}
                aria-pressed={spots === n}
                className={`h-11 min-w-11 rounded-lg border px-3 text-sm font-medium ${spots === n ? 'border-brand-600 bg-brand-700 text-white' : 'border-slate-200 hover:border-slate-400'}`}
              >
                {n}
              </button>
            ))}
          </div>
        </Section>
      )}
      {chosen && (
        <CustomerForm
          pending={pending}
          error={error}
          cta={t('booking.confirmClass')}
          summary={chosen.priceCents > 0 && <p className="rounded-lg bg-slate-50 p-3 text-sm">{t('booking.total')}: <b>{money(chosen.priceCents * spots)}</b></p>}
          onSubmit={(f) => onBook({ classSessionId: chosen.id, spots, ...f })}
        />
      )}
    </>
  );
}

// ---------- Space rentals ----------

function RentalsFlow({ business, onBook, pending, error, resetKey }: FlowProps) {
  const { t } = useTranslation();
  const durations = business.rentalDurations ?? [60];
  const [spaceId, setSpaceId] = useState('');
  const [duration, setDuration] = useState(durations[0]!);
  const [date, setDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [slot, setSlot] = useState('');
  const days = useOpenDays(business, 21);
  const space = business.spaces.find((s) => s.id === spaceId);
  const minPrice = Math.min(...business.spaces.map((s) => s.pricePerHourCents));
  const slots = useQuery({
    queryKey: ['slots', business.slug, spaceId, duration, date],
    queryFn: () => api<{ slots: string[] }>(`/public/${business.slug}/availability?durationMin=${duration}&date=${date}${spaceId ? `&spaceId=${spaceId}` : ''}`),
    enabled: Boolean(date),
  });
  useResetOnError(resetKey, () => { setSlot(''); void slots.refetch(); });
  const total = space ? spacePriceCents(space.pricePerHourCents, duration) : null;

  if (!business.spaces.length) return <p className="text-sm text-slate-500">{t('booking.noSpaces')}</p>;

  return (
    <>
      <Section title={t('booking.chooseSpace')}>
        <div className="grid gap-2 sm:grid-cols-2">
          {business.spaces.length > 1 && (
            <Chip on={!spaceId} onClick={() => { setSpaceId(''); setSlot(''); }}>
              <span className="font-medium">{t('booking.anySpace')}</span>
              <span className="block text-xs text-slate-500">{t('booking.fromPerHour', { price: money(minPrice) })}</span>
            </Chip>
          )}
          {business.spaces.map((s) => (
            <Chip key={s.id} on={spaceId === s.id} onClick={() => { setSpaceId(s.id); setSlot(''); }}>
              <span className="font-medium">{s.name}</span>
              <span className="block text-xs text-slate-500">{t('spaces.perHour', { price: money(s.pricePerHourCents) })}{s.description ? ` · ${s.description}` : ''}</span>
            </Chip>
          ))}
        </div>
      </Section>
      <Section title={t('booking.chooseDuration')}>
        <div className="flex flex-wrap gap-2">
          {durations.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setDuration(m); setSlot(''); }}
              aria-pressed={duration === m}
              className={`rounded-lg border px-3 py-2 text-sm font-medium ${duration === m ? 'border-brand-600 bg-brand-700 text-white' : 'border-slate-200 hover:border-slate-400'}`}
            >
              {m % 60 === 0 ? t('booking.hoursN', { count: m / 60 }) : `${m} ${t('common.minutes')}`}
            </button>
          ))}
        </div>
      </Section>
      <Section title={t('booking.chooseDate')}>
        <DayPicker days={days} value={date} onChange={(v) => { setDate(v); setSlot(''); }} />
      </Section>
      <Section title={t('booking.chooseStart')}>
        <SlotGrid loading={slots.isLoading} slots={slots.data?.slots} value={slot} onChange={setSlot} tz={business.timezone} />
      </Section>
      {slot && (
        <CustomerForm
          pending={pending}
          error={error}
          cta={t('booking.confirmRental')}
          summary={
            <p className="rounded-lg bg-slate-50 p-3 text-sm">
              {space ? space.name : t('booking.anySpace')} · {dateTime(slot, business.timezone)} · {duration} {t('common.minutes')}
              {total != null && total > 0 && <> · <b>{money(total)}</b></>}
            </p>
          }
          onSubmit={(f) => onBook({ spaceId: spaceId || null, durationMin: duration, startsAt: slot, ...f })}
        />
      )}
    </>
  );
}

// ---------- Confirmation ----------

function Success({ business, result, onAnother }: { business: PublicBusinessDto; result: PublicBookingResult; onAnother: () => void }) {
  const { t } = useTranslation();
  const when = dateTime(result.startsAt, business.timezone);
  const minutes = Math.round((new Date(result.endsAt).getTime() - new Date(result.startsAt).getTime()) / 60000);
  const [title, detail] =
    business.kind === 'reservations'
      ? [t('booking.successTitleTable'), t('booking.successTable', { count: result.partySize ?? 0, date: when })]
      : business.kind === 'classes'
        ? [t('booking.successClassTitle'), t('booking.successClass', { service: result.serviceName, date: when, count: result.partySize ?? 1 })]
        : business.kind === 'rentals'
          ? [t('booking.successRentalTitle'), t('booking.successRental', { space: result.resourceName ?? result.serviceName, date: when, minutes })]
          : [
              t('booking.success'),
              result.resourceName
                ? t('booking.successDetailWith', { service: result.serviceName, date: when, name: result.resourceName })
                : t('booking.successDetail', { service: result.serviceName, date: when }),
            ];
  return (
    <div className="card text-center">
      <div className="mb-2 text-4xl">✓</div>
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-2 text-slate-600">{detail}</p>
      {result.priceCents > 0 && business.kind !== 'appointments' && (
        <p className="mt-1 text-sm text-slate-500">{t('booking.total')}: {money(result.priceCents)}</p>
      )}
      {result.deposit && <DepositBox deposit={result.deposit} />}
      <div className="mt-6 rounded-xl bg-slate-50 p-4 text-left text-sm">
        <p className="text-slate-700">{t('booking.manageHelp')}</p>
        <a className="mt-2 inline-block font-medium text-brand-700 underline" href={result.managePath}>{t('booking.manageLink')}</a>
      </div>
      <button className="btn-secondary mt-6" onClick={onAnother}>{t('booking.another')}</button>
    </div>
  );
}

function DepositBox({ deposit }: { deposit: NonNullable<PublicBookingResult['deposit']> }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-left text-sm">
      <div className="font-semibold text-amber-900">{t('booking.depositTitle', { amount: money(deposit.amountCents) })}</div>
      <p className="mt-1 text-amber-800">{t('booking.depositHelp')}</p>
      {deposit.checkoutUrl ? (
        <a className="btn-primary mt-3 w-full" href={deposit.checkoutUrl} target="_blank" rel="noreferrer">
          {deposit.method === 'spei' ? t('booking.paySpei') : t('booking.payNow')}
        </a>
      ) : deposit.transfer ? (
        <div className="mt-3 space-y-1 rounded-lg bg-white p-3">
          <div>{t('paymentSettings.bank')}: <b>{deposit.transfer.bank}</b></div>
          <div>{t('paymentSettings.holder')}: <b>{deposit.transfer.accountHolder}</b></div>
          <div className="flex items-center justify-between gap-2">
            <span>CLABE: <b className="font-mono">{deposit.transfer.clabe}</b></span>
            <button
              type="button"
              className="text-brand-700"
              onClick={() => {
                void navigator.clipboard?.writeText(deposit.transfer!.clabe);
                setCopied(true);
              }}
            >
              {copied ? t('common.copied') : t('common.copy')}
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-2 text-amber-800">{t('booking.depositContact')}</p>
      )}
    </div>
  );
}
