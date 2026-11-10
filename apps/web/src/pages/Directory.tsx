import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { BUSINESS_CATEGORIES, businessCategory, CATEGORY_TYPES, type BusinessCategory, type BusinessType, type DirectoryDto, type DirectoryEntryDto } from '@agenda/shared';
import { LanguageSwitch } from '../components/Layout';
import { distanceKm, MapView, type MapMarker } from '../components/MapView';
import { LoginModal } from './Auth';
import { useAuth } from '../lib/auth';
import { Loading } from '../components/ui';
import { api } from '../lib/api';
import { money } from '../lib/format';

/** One icon and colour per category: easier to scan than 20 specific types. */
export const CATEGORY_STYLE: Record<BusinessCategory, { icon: string; color: string }> = {
  health: { icon: '🩺', color: '#2563eb' },
  beauty: { icon: '💈', color: '#db2777' },
  food: { icon: '🍽️', color: '#ea580c' },
  classes: { icon: '🧘', color: '#7c3aed' },
  spaces: { icon: '🎾', color: '#16a34a' },
  pets: { icon: '🐾', color: '#a16207' },
  other: { icon: '✨', color: '#475569' },
};
const styleOf = (t: BusinessType) => CATEGORY_STYLE[businessCategory(t)];

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Public page (no login): map + list of businesses that opted into the directory. */
/** Booking link; businesses with several locations open on the chosen one. */
const bookHref = (e: { slug: string; locationId: string; locationName: string | null }) =>
  e.locationName ? `/b/${e.slug}?l=${e.locationId}` : `/b/${e.slug}`;

export function DirectoryPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const loginOpen = params.get('login') === '1' && !user;
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'map'>('list');
  const [me, setMe] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locError, setLocError] = useState(false);

  const type = params.get('tipo') ?? '';
  const cat = (params.get('categoria') ?? '') as BusinessCategory | '';
  const state = params.get('estado') ?? '';
  const city = params.get('ciudad') ?? '';
  const q = params.get('q') ?? '';
  const onlineOnly = params.get('reserva') === '1';
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (!v) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
    setSelected(null);
  };

  const dir = useQuery({ queryKey: ['directory'], queryFn: () => api<DirectoryDto>('/public-directory') });
  const all = dir.data?.entries ?? [];

  const inZone = (e: DirectoryEntryDto) => (!state || e.state === state) && (!city || e.city === city);
  const matchesText = (e: DirectoryEntryDto) =>
    !q || norm(`${e.name} ${e.description ?? ''} ${e.neighborhood ?? ''} ${e.city ?? ''} ${t(`businessTypes.${e.businessType}`)}`).includes(norm(q));

  const results = useMemo(() => {
    const list = all.filter((e) => (!cat || businessCategory(e.businessType) === cat) && (!type || e.businessType === type) && inZone(e) && matchesText(e) && (!onlineOnly || e.onlineBooking));
    if (me) list.sort((a, b) => distanceKm(me, a) - distanceKm(me, b));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, cat, type, state, city, q, onlineOnly, me]);

  // Category tiles (with counts in the current zone/search), then the specific types of the chosen one
  const counts = useMemo(() => {
    const byCat = new Map<BusinessCategory, number>();
    const byType = new Map<string, number>();
    for (const e of all) {
      if (!inZone(e) || !matchesText(e)) continue;
      const c = businessCategory(e.businessType);
      byCat.set(c, (byCat.get(c) ?? 0) + 1);
      byType.set(e.businessType, (byType.get(e.businessType) ?? 0) + 1);
    }
    return { byCat, byType };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [all, state, city, q]);
  const subTypes = cat ? CATEGORY_TYPES[cat].filter((x) => counts.byType.get(x)) : [];

  const cities = dir.data?.zones.find((z) => z.state === state)?.cities ?? [];

  const markers: MapMarker[] = useMemo(
    () =>
      results.map((e) => ({
        id: e.locationId,
        lat: e.lat,
        lng: e.lng,
        color: styleOf(e.businessType).color,
        title: e.locationName ? `${e.name} · ${e.locationName}` : e.name,
        popup: {
          heading: e.locationName ? `${e.name} · ${e.locationName}` : e.name,
          lines: [t(`businessTypes.${e.businessType}`), [e.neighborhood, e.city].filter(Boolean).join(', ')],
          link: e.onlineBooking ? { href: bookHref(e), label: t(`directory.cta.${e.kind}`) } : undefined,
        },
      })),
    [results, t],
  );

  const locate = () => {
    if (!navigator.geolocation) return setLocError(true);
    setLocating(true);
    setLocError(false);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setMe({ lat: p.coords.latitude, lng: p.coords.longitude });
        setLocating(false);
      },
      () => {
        setLocating(false);
        setLocError(true);
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  };

  const fitKey = `${cat}|${type}|${state}|${city}|${q}|${onlineOnly}|${results.length}`;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <Link to="/" className="font-bold text-brand-700">Agenda</Link>
          <div className="flex items-center gap-2">
            <LanguageSwitch />
            {user ? (
              <Link to="/agenda" className="btn-primary !py-1.5 text-sm">{t('directory.myBusiness')}</Link>
            ) : (
              <>
                <Link to="/registro" className="hidden text-sm font-medium text-brand-700 sm:inline">{t('directory.forBusinesses')}</Link>
                <button type="button" className="btn-primary !py-1.5 text-sm" onClick={() => set({ login: '1' })}>{t('auth.login')}</button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">{t('directory.heading')}</h1>
        <p className="mt-1 text-slate-600">{t('directory.subheading')}</p>

        {/* Filters */}
        <div className="mt-5 space-y-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]">
            <input
              type="search"
              className="input"
              placeholder={t('directory.searchPlaceholder')}
              value={q}
              onChange={(e) => set({ q: e.target.value })}
              aria-label={t('common.search')}
            />
            <select className="input" value={state} onChange={(e) => set({ estado: e.target.value, ciudad: null })} aria-label={t('directory.state')}>
              <option value="">{t('directory.allStates')}</option>
              {dir.data?.zones.map((z) => <option key={z.state} value={z.state}>{z.state}</option>)}
            </select>
            <select className="input" value={city} disabled={!state} onChange={(e) => set({ ciudad: e.target.value })} aria-label={t('directory.city')}>
              <option value="">{t('directory.allCities')}</option>
              {cities.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button className="btn-secondary whitespace-nowrap" onClick={me ? () => setMe(null) : locate} disabled={locating}>
              {locating ? t('common.loading') : me ? t('directory.clearNearMe') : `◎ ${t('directory.nearMe')}`}
            </button>
          </div>
          {locError && <p className="text-sm text-amber-700">{t('directory.locationDenied')}</p>}

          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-4 sm:overflow-visible sm:px-0 lg:grid-cols-8" role="group" aria-label={t('directory.categories')}>
            <button
              onClick={() => set({ categoria: null, tipo: null })}
              aria-pressed={!cat}
              className={`flex min-w-[6.5rem] flex-col items-center gap-1 rounded-xl border px-3 py-2 text-sm font-medium ${!cat ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400'}`}
            >
              <span className="text-xl leading-none" aria-hidden>🔎</span>
              {t('directory.allTypes')}
            </button>
            {BUSINESS_CATEGORIES.filter((c) => counts.byCat.get(c)).map((c) => (
              <button
                key={c}
                data-testid={`category-${c}`}
                onClick={() => set({ categoria: cat === c ? null : c, tipo: null })}
                aria-pressed={cat === c}
                className={`flex min-w-[6.5rem] flex-col items-center gap-1 rounded-xl border px-3 py-2 text-sm font-medium ${cat === c ? 'text-white' : 'border-slate-200 bg-white text-slate-800 hover:border-slate-400'}`}
                style={cat === c ? { background: CATEGORY_STYLE[c].color, borderColor: CATEGORY_STYLE[c].color } : undefined}
              >
                <span className="text-xl leading-none" aria-hidden>{CATEGORY_STYLE[c].icon}</span>
                <span className="whitespace-nowrap">{t(`categories.${c}`)}</span>
                <span className={`text-xs ${cat === c ? 'text-white/80' : 'text-slate-500'}`}>{counts.byCat.get(c)}</span>
              </button>
            ))}
          </div>
          {subTypes.length > 1 && (
            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1" role="group" aria-label={t('directory.specialty')}>
              {subTypes.map((bt) => (
                <button
                  key={bt}
                  onClick={() => set({ tipo: type === bt ? null : bt })}
                  aria-pressed={type === bt}
                  className={`whitespace-nowrap rounded-full border px-3 py-1 text-sm ${type === bt ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-300 bg-white text-slate-700'}`}
                >
                  {t(`businessTypes.${bt}`)} <span className="opacity-60">{counts.byType.get(bt)}</span>
                </button>
              ))}
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={onlineOnly} onChange={(e) => set({ reserva: e.target.checked ? '1' : null })} />
            {t('directory.onlineOnly')}
          </label>
        </div>

        {/* Mobile view switch */}
        <div className="mt-4 grid grid-cols-2 rounded-lg border border-slate-300 bg-white p-1 text-sm lg:hidden" role="tablist">
          {(['list', 'map'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`rounded-md py-1.5 ${view === v ? 'bg-slate-800 text-white' : 'text-slate-600'}`}>
              {v === 'list' ? t('directory.list') : t('directory.map')}
            </button>
          ))}
        </div>

        {dir.isLoading ? (
          <Loading />
        ) : dir.isError ? (
          <p className="mt-6 text-rose-700">{t('common.error')}</p>
        ) : (
          <>
          <p className="mt-4 text-sm text-slate-500">{t('directory.results', { count: results.length })}</p>
          {/* List and map share the same height, so their tops and bottoms line up */}
          <div className="mt-2 grid gap-4 lg:grid-cols-5">
            <section className={`lg:col-span-2 lg:h-[calc(100vh-200px)] lg:min-h-[420px] ${view === 'map' ? 'hidden lg:block' : ''}`} aria-label={t('directory.list')}>
              {results.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 p-8 text-center text-slate-500">{t('directory.empty')}</div>
              ) : (
                <ul className="space-y-3 lg:h-full lg:overflow-y-auto lg:pr-1">
                  {results.map((e) => (
                    <li key={e.locationId}>
                      <article
                        className={`card cursor-pointer !p-4 transition ${selected === e.locationId ? 'ring-2 ring-brand-500' : 'hover:border-slate-300'}`}
                        onClick={() => setSelected(e.locationId)}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <span
                              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold"
                              style={{ background: `${styleOf(e.businessType).color}1a`, color: styleOf(e.businessType).color }}
                            >
                              <span aria-hidden>{styleOf(e.businessType).icon}</span>
                              {t(`businessTypes.${e.businessType}`)}
                            </span>
                            <h2 className="mt-0.5 truncate font-semibold text-slate-900">{e.name}</h2>
                            {e.locationName && <div className="truncate text-xs font-medium text-brand-700">⌂ {e.locationName}</div>}
                            <p className="truncate text-sm text-slate-500">{[e.neighborhood, e.city].filter(Boolean).join(', ')}</p>
                          </div>
                          <div className="shrink-0 text-right text-xs text-slate-500">
                            {me && <div className="font-medium text-slate-700">{distanceKm(me, e).toFixed(1)} km</div>}
                            {e.priceFromCents != null && <div>{t(e.priceUnit === 'hour' ? 'directory.fromPerHour' : 'directory.from', { price: money(e.priceFromCents) })}</div>}
                          </div>
                        </div>
                        {e.description && <p className="mt-2 line-clamp-2 text-sm text-slate-600">{e.description}</p>}
                        <div className="mt-3 flex flex-wrap gap-2">
                          {e.onlineBooking ? (
                            <Link to={bookHref(e)} className="btn-primary !py-1.5 text-sm" onClick={(ev) => ev.stopPropagation()}>
                              {t(`directory.cta.${e.kind}`)}
                            </Link>
                          ) : (
                            <span className="text-sm text-slate-500">{t('directory.noOnline')}</span>
                          )}
                          {e.phone && (
                            <a className="btn-secondary !py-1.5 text-sm" href={`https://wa.me/${e.phone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer" onClick={(ev) => ev.stopPropagation()}>
                              WhatsApp
                            </a>
                          )}
                          <button
                            className="btn-secondary !py-1.5 text-sm lg:hidden"
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setSelected(e.locationId);
                              setView('map');
                            }}
                          >
                            {t('directory.showOnMap')}
                          </button>
                        </div>
                      </article>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className={`lg:col-span-3 ${view === 'list' ? 'hidden lg:block' : ''}`} aria-label={t('directory.map')}>
              <MapView
                markers={markers}
                selectedId={selected}
                onSelect={setSelected}
                userLocation={me}
                fitKey={`${fitKey}|${view}`}
                className="h-[60vh] lg:h-[calc(100vh-200px)] lg:min-h-[420px]"
              />
            </section>
          </div>
          </>
        )}

        <div className="mt-10 rounded-2xl bg-brand-700 p-6 text-white sm:flex sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">{t('directory.ctaTitle')}</h2>
            <p className="text-brand-50/90 text-sm">{t('directory.ctaText')}</p>
          </div>
          <Link to="/registro" className="mt-3 inline-block rounded-lg bg-white px-4 py-2 font-semibold text-brand-800 sm:mt-0">{t('directory.ctaButton')}</Link>
        </div>
      </main>
      {loginOpen && <LoginModal onClose={() => set({ login: null })} />}
    </div>
  );
}
