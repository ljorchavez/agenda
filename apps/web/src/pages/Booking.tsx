import { PublicReviews, RatingBadge } from '../components/Reviews';
import { ShopSection } from '../components/Shop';
import { SocialButton } from '../components/SocialIcons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery } from '@tanstack/react-query';
import { addDays, format } from 'date-fns';
import {
  bookingPriceCents,
  isHealthType,
  eligibleResources,
  kindConfig,
  discountCents,
  openIntervals,
  socialUrl,
  type PublicBookingResult,
  type PublicBusinessDto,
  type PublicClassSessionDto,
} from '@agenda/shared';
import { LanguageSwitch } from '../components/Layout';
import { ErrorText, Loading } from '../components/ui';
import { api } from '../lib/api';
import { dateLocale, dateTime, money } from '../lib/format';
import { Avatar } from '../components/Photo';

type Book = (body: Record<string, unknown>) => void;
/** `loc` is the chosen location (sucursal); `business` already shows only its resources and hours. */
type FlowProps = { business: PublicBusinessDto; loc: string; onBook: Book; pending: boolean; error: unknown; resetKey: number };

/** Public page where end customers book by themselves: /b/:slug */
export function BookingPage() {
  const { slug = '' } = useParams();
  const { t, i18n } = useTranslation();
  const [resetKey, setResetKey] = useState(0);
  const [params, setParams] = useSearchParams();
  const chosenLoc = params.get('l') ?? '';

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

  const full = biz.data;
  // Several locations: the customer picks one first (or arrives with ?l= from the directory).
  const multi = full.locations.length > 1;
  const location = full.locations.find((l) => l.id === chosenLoc) ?? (multi ? undefined : full.locations[0]);
  const business: PublicBusinessDto = location
    ? {
        ...full,
        hours: location.hours,
        phone: location.phone ?? full.phone,
        address: location.address,
        neighborhood: location.neighborhood,
        city: location.city,
        state: location.state,
        lat: location.lat,
        lng: location.lng,
        resources: full.resources.filter((r) => r.locationId === location.id),
      }
    : full;
  const pickLocation = (id: string) => {
    const next = new URLSearchParams(params);
    if (id) next.set('l', id);
    else next.delete('l');
    setParams(next, { replace: true });
    book.reset();
  };
  const mapsUrl =
    business.lat != null
      ? `https://www.google.com/maps/search/?api=1&query=${business.lat},${business.lng}`
      : business.address
        ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([business.address, business.neighborhood, business.city].filter(Boolean).join(', '))}`
        : null;
  const subtitle = t(`kinds.${business.kind}.publicTitle`);
  const loc = location?.id ?? '';
  const flowProps: FlowProps = { business, loc, onBook: (b) => book.mutate({ ...b, ...(loc ? { locationId: loc } : {}) }), pending: book.isPending, error: book.error, resetKey };

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 to-slate-100 px-3 py-4 sm:px-4 sm:py-8">
      <div className="mx-auto max-w-2xl">
        <ProfileHeader business={business} subtitle={subtitle} mapsUrl={mapsUrl} locationLine={multi && location ? (
          <p className="text-sm font-medium text-brand-700">
            ⌂ {location.name} ·{' '}
            <button className="underline" onClick={() => pickLocation('')}>{t('booking.changeLocation')}</button>
          </p>
        ) : null} />

        {multi && !location ? (
          <div className="card">
            <Section title={t('booking.chooseLocation')}>
              <div className="grid gap-2">
                {full.locations.map((l) => (
                  <button key={l.id} onClick={() => pickLocation(l.id)} className="rounded-lg border border-slate-300 p-3 text-left hover:border-brand-500">
                    <span className="block font-medium text-slate-800">⌂ {l.name}</span>
                    <span className="block text-sm text-slate-500">{[l.address, l.neighborhood, l.city].filter(Boolean).join(', ') || '—'}</span>
                    <span className="block text-xs text-slate-400">{l.hours.open}–{l.hours.close}</span>
                  </button>
                ))}
              </div>
            </Section>
          </div>
        ) : book.isSuccess ? (
          <Success business={business} result={book.data} onAnother={() => book.reset()} />
        ) : (
          <div className="card space-y-6" key={loc}>
            {kindConfig(business.kind).sessions ? <ClassesFlow {...flowProps} /> : <BookingFlow {...flowProps} />}
          </div>
        )}
        {!book.isSuccess && <ShopSection business={full} />}
        {!book.isSuccess && <PublicReviews summary={full.reviews} />}
        <p className="text-center text-sm">
          <Link to={`/p/${full.slug}`} className="text-brand-700 hover:underline" data-testid="portal-link">
            {t(isHealthType(full.businessType) ? 'portal.myPortal' : 'portal.myAppointments')}
          </Link>
        </p>
      </div>
    </div>
  );
}

// ---------- Shared pieces ----------

/** "Lun–Sáb · 9:00–14:00, 16:00–19:00" */
function hoursText(h: PublicBusinessDto['hours'], locale: string) {
  const name = (iso: number) => new Date(Date.UTC(2024, 0, iso)).toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' }).replace('.', '');
  const days = [...h.days].sort((a, b) => a - b);
  // Group consecutive days: 1-6 → "lun–sáb"
  const runs: number[][] = [];
  for (const d of days) {
    const last = runs[runs.length - 1];
    if (last && d === last[last.length - 1]! + 1) last.push(d);
    else runs.push([d]);
  }
  const dayTxt = runs.map((r) => (r.length > 2 ? `${name(r[0]!)}–${name(r[r.length - 1]!)}` : r.map(name).join(', '))).join(', ');
  const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  const times = openIntervals(h).map(([a, b]) => `${hm(a)}–${hm(b)}`).join(', ');
  return `${dayTxt.charAt(0).toUpperCase()}${dayTxt.slice(1)} · ${times}`;
}

/** Social-style header: banner, profile picture, name, about, notice, location, hours, links and a few photos. */
function ProfileHeader({ business, subtitle, mapsUrl, locationLine }: { business: PublicBusinessDto; subtitle: string; mapsUrl: string | null; locationLine: ReactNode }) {
  const { t, i18n } = useTranslation();
  const page = business.page;
  const [zoom, setZoom] = useState<string | null>(null);
  const socials = (['instagram', 'facebook', 'tiktok'] as const)
    .map((n) => ({ n, url: socialUrl(n, page[n]) }))
    .filter((x): x is { n: 'instagram' | 'facebook' | 'tiktok'; url: string } => Boolean(x.url));
  const wa = business.phone ? `https://wa.me/${business.phone.replace(/\D/g, '')}` : null;
  const address = [business.address, business.neighborhood, business.city].filter(Boolean).join(', ');
  return (
    <header className="card mb-6 overflow-hidden !p-0" data-testid="profile-header">
      <div className="relative h-32 bg-gradient-to-r from-brand-600 to-brand-800 sm:h-48">
        {page.bannerUrl && <img src={page.bannerUrl} alt="" className="h-full w-full object-cover" />}
        <Link to="/" className="absolute left-3 top-3 rounded-full bg-white/90 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-white">← {t('directory.title')}</Link>
        <div className="absolute right-3 top-3"><LanguageSwitch /></div>
      </div>
      <div className="px-4 pb-5 sm:px-6">
        <div className="relative z-10 -mt-10 sm:-mt-12">
          <span className="inline-block rounded-full bg-white p-1 shadow-md">
            <Avatar name={business.name} photoUrl={page.logoUrl} size={88} />
          </span>
        </div>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">{business.name}</h1>
        {business.reviews.count > 0 && (
          <a href="#resenas" className="hover:underline">
            <RatingBadge average={business.reviews.average} count={business.reviews.count} />
          </a>
        )}
        {locationLine}
        <p className="text-slate-600">{subtitle}</p>
        {business.description && <p className="mt-2 text-sm text-slate-700">{business.description}</p>}
        {page.notice && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">📣 {page.notice}</p>}
        <ul className="mt-3 space-y-1 text-sm text-slate-600">
          {address && (
            <li>
              📍 {address}
              {mapsUrl && <> · <a href={mapsUrl} target="_blank" rel="noreferrer" className="font-medium text-brand-700">{t('booking.directions')}</a></>}
            </li>
          )}
          <li>🕒 {hoursText(business.hours, i18n.language.startsWith('en') ? 'en-US' : 'es-MX')}</li>
        </ul>
        {(wa || socials.length > 0) && (
          <div className="mt-3 flex flex-wrap gap-2">
            {wa && <SocialButton net="whatsapp" href={wa} />}
            {socials.map((x) => <SocialButton key={x.n} net={x.n} href={x.url} />)}
          </div>
        )}
        {page.gallery.length > 0 && (
          <div className="mt-4 grid grid-cols-4 gap-1.5 sm:grid-cols-6" data-testid="gallery">
            {page.gallery.slice(0, 8).map((u) => (
              <button key={u} type="button" onClick={() => setZoom(u)} className="aspect-square overflow-hidden rounded-lg">
                <img src={u} alt="" loading="lazy" className="h-full w-full object-cover transition hover:scale-105" />
              </button>
            ))}
          </div>
        )}
      </div>
      {zoom && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setZoom(null)} role="dialog" aria-label={t('page.photo')}>
          <img src={zoom} alt="" className="max-h-full max-w-full rounded-lg" />
        </div>
      )}
    </header>
  );
}

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

type CouponCheck = { code: string; discountType: 'percent' | 'amount'; value: number };

function CustomerForm({ onSubmit, pending, error, summary, cta, promo }: {
  onSubmit: (f: { name: string; phone: string; email?: string; couponCode?: string }) => void;
  pending: boolean;
  error: unknown;
  summary?: ReactNode;
  cta: string;
  /** Coupon box and loyalty reward note (bookings with a price) */
  promo?: { slug: string; totalCents: number; coupons: boolean; reward: PublicBusinessDto['promos']['reward']; serviceId?: string | null };
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ name: '', phone: '', email: '' });
  const [code, setCode] = useState('');
  const [coupon, setCoupon] = useState<CouponCheck | null>(null);
  const check = useMutation({
    mutationFn: () =>
      api<CouponCheck>(
        `/public/${promo!.slug}/coupons/${encodeURIComponent(code.trim())}?${new URLSearchParams({ ...(promo!.serviceId ? { serviceId: promo!.serviceId } : {}), ...(form.phone ? { phone: form.phone } : {}) })}`,
      ),
    onSuccess: setCoupon,
  });
  const off = coupon && promo ? discountCents(promo.totalCents, coupon) : 0;
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSubmit({ ...form, email: form.email || undefined, ...(coupon ? { couponCode: coupon.code } : {}) }); }}>
      <h2 className="font-semibold">{t('booking.yourData')}</h2>
      {summary}
      {promo?.reward && promo.totalCents > 0 && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
          🎁 {t('promos.rewardPublic', { count: promo.reward.everyVisits, off: promo.reward.discountType === 'percent' ? `${promo.reward.value}%` : money(promo.reward.value) })}
        </p>
      )}
      <input required minLength={2} placeholder={t('customers.name')} className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <input required type="tel" placeholder={t('customers.phone')} className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      <input type="email" placeholder={`${t('customers.email')} (${t('common.optional')})`} className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      {promo?.coupons && promo.totalCents > 0 && (
        coupon ? (
          <p className="flex items-center justify-between rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-900" data-testid="coupon-applied">
            <span>🏷️ {coupon.code}: −{money(off)} · <b>{money(promo.totalCents - off)}</b></span>
            <button type="button" className="text-xs underline" onClick={() => { setCoupon(null); setCode(''); }}>{t('common.remove')}</button>
          </p>
        ) : (
          <div>
            <div className="flex gap-2">
              <input className="input uppercase" placeholder={t('promos.couponPlaceholder')} aria-label={t('promos.coupon')} value={code} onChange={(e) => setCode(e.target.value)} />
              <button type="button" className="btn-secondary shrink-0" disabled={code.trim().length < 3 || check.isPending} onClick={() => check.mutate()}>{t('promos.apply')}</button>
            </div>
            <ErrorText error={check.error} ns="promos" />
          </div>
        )
      )}
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

// ---------- Bookings (every kind except group classes) ----------

/**
 * One flow for every kind: what (service, party size or length) → who/where (resource, optional)
 * → day → time → contact details. KIND_CONFIG decides which of the first steps apply.
 */
function BookingFlow({ business, loc, onBook, pending, error, resetKey }: FlowProps) {
  const { t } = useTranslation();
  const kind = business.kind;
  const cfg = kindConfig(kind);
  const needsService = !cfg.partySize && !cfg.durations;
  // Tables are assigned by the system (best fit for the party); people and spaces can be chosen.
  const pickResource = !cfg.partySize;
  const durations = business.rentalDurations ?? [60];
  const [serviceId, setServiceId] = useState('');
  const [partySize, setPartySize] = useState(2);
  const [duration, setDuration] = useState(durations[0]!);
  const [resourceId, setResourceId] = useState('');
  const [date, setDate] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const [slot, setSlot] = useState('');
  const days = useOpenDays(business, 21);
  const service = business.services.find((s) => s.id === serviceId);
  const ready = needsService ? Boolean(service) : true;
  const eligible = eligibleResources(business.resources, { serviceId: needsService ? serviceId || null : null, partySize: cfg.partySize ? partySize : null });
  const resource = business.resources.find((r) => r.id === resourceId);
  const minutes = cfg.durations ? duration : service?.durationMin ?? 0;
  const total = bookingPriceCents(resource, service?.priceCents ?? 0, minutes);
  const rates = business.resources.map((r) => r.pricePerHourCents).filter((x): x is number => x != null);
  const qs = new URLSearchParams({ date });
  if (needsService) qs.set('serviceId', serviceId);
  if (cfg.partySize) qs.set('partySize', String(partySize));
  if (cfg.durations) qs.set('durationMin', String(duration));
  if (resourceId) qs.set('resourceId', resourceId);
  if (loc) qs.set('locationId', loc);
  const slots = useQuery({
    queryKey: ['slots', business.slug, qs.toString()],
    queryFn: () => api<{ slots: string[] }>(`/public/${business.slug}/availability?${qs.toString()}`),
    enabled: ready && Boolean(date),
  });
  useResetOnError(resetKey, () => { setSlot(''); void slots.refetch(); });
  const reset = () => setSlot('');

  if (cfg.durations && !business.resources.length) return <p className="text-sm text-slate-500">{t('booking.noSpaces')}</p>;

  return (
    <>
      {cfg.partySize && (
        <Section title={t('booking.choosePeople')}>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: business.maxPartySize ?? 8 }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => { setPartySize(n); reset(); }}
                className={`h-11 min-w-11 rounded-lg border px-3 text-sm font-medium ${partySize === n ? 'border-brand-600 bg-brand-700 text-white' : 'border-slate-200 hover:border-slate-400'}`}
                aria-pressed={partySize === n}
              >
                {n}
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">{t('booking.largerGroups')}</p>
        </Section>
      )}

      {needsService && (
        <Section title={t('booking.chooseService')}>
          <div className="grid gap-2">
            {business.services.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  setServiceId(s.id);
                  reset();
                  if (resourceId && !eligibleResources(business.resources, { serviceId: s.id }).some((r) => r.id === resourceId)) setResourceId('');
                }}
                className={`flex items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm ${serviceId === s.id ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:border-slate-400'}`}
              >
                <span className="flex min-w-0 items-center gap-3">
                  {s.photoUrl && <img src={s.photoUrl} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-lg object-cover" />}
                  <span className="font-medium">{s.name}</span>
                </span>
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
      )}

      {ready && pickResource && eligible.length > 0 && (
        <Section title={t(`kinds.${kind}.chooseResource`)}>
          <div className="grid gap-2 sm:grid-cols-2">
            {eligible.length > 1 && (
              <Chip on={!resourceId} onClick={() => { setResourceId(''); reset(); }}>
                <span className="font-medium">{t('booking.anyResource')}</span>
                {rates.length > 0 && <span className="block text-xs text-slate-500">{t('booking.fromPerHour', { price: money(Math.min(...rates)) })}</span>}
              </Chip>
            )}
            {eligible.map((r) => (
              <Chip key={r.id} on={resourceId === r.id} onClick={() => { setResourceId(r.id); reset(); }}>
                <span className="flex items-center gap-2 font-medium">
                  {r.photoUrl ? (
                    <Avatar name={r.name} color={r.color} photoUrl={r.photoUrl} size={32} />
                  ) : (
                    <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
                  )}
                  {r.name}
                </span>
                {(r.pricePerHourCents != null || r.description) && (
                  <span className="block text-xs text-slate-500">
                    {[r.pricePerHourCents != null && t('resources.perHour', { price: money(r.pricePerHourCents) }), r.description].filter(Boolean).join(' · ')}
                  </span>
                )}
              </Chip>
            ))}
          </div>
        </Section>
      )}

      {cfg.durations && (
        <Section title={t('booking.chooseDuration')}>
          <div className="flex flex-wrap gap-2">
            {durations.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setDuration(m); reset(); }}
                aria-pressed={duration === m}
                className={`rounded-lg border px-3 py-2 text-sm font-medium ${duration === m ? 'border-brand-600 bg-brand-700 text-white' : 'border-slate-200 hover:border-slate-400'}`}
              >
                {m % 60 === 0 ? t('booking.hoursN', { count: m / 60 }) : `${m} ${t('common.minutes')}`}
              </button>
            ))}
          </div>
        </Section>
      )}

      {ready && (
        <>
          <Section title={t('booking.chooseDate')}>
            <DayPicker days={days} value={date} onChange={(v) => { setDate(v); reset(); }} />
          </Section>
          <Section title={t('booking.chooseTime')}>
            <SlotGrid loading={slots.isLoading} slots={slots.data?.slots} value={slot} onChange={setSlot} tz={business.timezone} />
          </Section>
        </>
      )}

      {slot && ready && (
        <CustomerForm
          pending={pending}
          error={error}
          cta={t(`kinds.${kind}.confirm`)}
          promo={{ slug: business.slug, totalCents: total, coupons: business.promos.coupons, reward: business.promos.reward, serviceId: needsService ? serviceId : null }}
          summary={
            <p className="rounded-lg bg-slate-50 p-3 text-sm">
              {[
                service?.name,
                cfg.partySize && t('booking.people', { count: partySize }),
                resource?.name ?? (pickResource && eligible.length > 1 ? t('booking.anyResource') : null),
                dateTime(slot, business.timezone),
                cfg.durations && `${duration} ${t('common.minutes')}`,
              ].filter(Boolean).join(' · ')}
              {total > 0 && <> · <b>{money(total)}</b></>}
            </p>
          }
          onSubmit={(f) =>
            onBook({
              ...(needsService ? { serviceId } : {}),
              ...(cfg.partySize ? { partySize } : {}),
              ...(cfg.durations ? { durationMin: duration } : {}),
              resourceId: resourceId || null,
              startsAt: slot,
              ...f,
            })
          }
        />
      )}
    </>
  );
}

// ---------- Group classes ----------

function ClassesFlow({ business, loc, onBook, pending, error, resetKey }: FlowProps) {
  const { t } = useTranslation();
  const fmt = useSlotFormat(business.timezone);
  const classes = useQuery({
    queryKey: ['public-classes', business.slug, loc],
    queryFn: () => api<PublicClassSessionDto[]>(`/public/${business.slug}/classes?days=14${loc ? `&locationId=${loc}` : ''}`),
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
                  {c.resourceName && <span className="block text-xs text-slate-500">{t('booking.withInstructor', { name: c.resourceName })}</span>}
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
          cta={t(`kinds.${business.kind}.confirm`)}
          promo={{ slug: business.slug, totalCents: chosen.priceCents * spots, coupons: business.promos.coupons, reward: business.promos.reward, serviceId: chosen.serviceId }}
          summary={chosen.priceCents > 0 && <p className="rounded-lg bg-slate-50 p-3 text-sm">{t('booking.total')}: <b>{money(chosen.priceCents * spots)}</b></p>}
          onSubmit={(f) => onBook({ classSessionId: chosen.id, spots, ...f })}
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
  const cfg = kindConfig(business.kind);
  // Same confirmation for every kind; only the title wording changes.
  const detail = [
    !cfg.partySize && !cfg.durations && result.serviceName,
    result.partySize != null && (cfg.sessions ? t('classes.spotsN', { count: result.partySize }) : t('booking.people', { count: result.partySize })),
    result.resourceName,
    when,
    cfg.durations && `${minutes} ${t('common.minutes')}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const title = t(`kinds.${business.kind}.successTitle`);
  return (
    <div className="card text-center">
      <div className="mb-2 text-4xl">✓</div>
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-2 text-slate-600">{detail}</p>
      {result.priceCents > 0 && (
        <p className="mt-1 text-sm text-slate-500">{t('booking.total')}: {money(result.priceCents)}</p>
      )}
      {result.discountCents > 0 && (
        <p className="mt-1 text-sm font-medium text-emerald-700" data-testid="booking-discount">
          {result.discountReason === 'reward' ? '🎁 ' + t('promos.rewardApplied') : '🏷️ ' + t('promos.couponApplied')}: −{money(result.discountCents)}
        </p>
      )}
      {result.plans.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900" data-testid="booking-plans">
          {result.plans.map((p) => (
            <li key={p.name}>🎟️ {p.sessionsLeft == null ? t('sales.publicUnlimited', { name: p.name }) : t('sales.publicLeft', { count: p.sessionsLeft, name: p.name })}</li>
          ))}
        </ul>
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
