import { AppointmentForms } from '../components/Forms';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, format, isSameDay, startOfDay, startOfWeek } from 'date-fns';
import {
  bookingPriceCents,
  computeDepositCents,
  couponsEnabled,
  rewardSettingsOf,
  eligibleResources,
  intervalsOnWeekday,
  kindConfig,
  noShowOwes,
  paymentSettingsOf,
  rentalSettingsOf,
  selfServiceOf,
  type AppointmentDto,
  type AvailabilityCheckDto,
  type BusinessHours,
  type ClassSessionDto,
  type CustomerDto,
  type DiscountPreviewDto,
  type PlanChoiceDto,
  PLAN_LIMITS,
  type PaymentDto,
  type ResourceDto,
  type TimeBlockDto,
} from '@agenda/shared';
import { useAccess, useAuth } from '../lib/auth';
import { ErrorText, Loading, MenuButton, MethodTags, Modal, PageHeader, PaymentBadge, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { dateLocale, dateTime, money, timeOnly, toCents, toLocalInput } from '../lib/format';
import { useMyLocations, useResources, useServices } from '../lib/queries';
import { LocationSelect } from '../components/Locations';
import { CalendarGrid, type CalBlock, type CalColumn, type CalEvent } from '../components/CalendarGrid';
import type { HoursValue } from '../components/Schedule';
import { StarRating } from '../components/Rating';
import { BOOKING_ICON, PAYMENT_PILL, PAYMENT_PILL_TEXT, paymentState } from '../lib/status';
import { NewSessionModal, SessionModal } from '../components/ClassModals';
import { CustomerPicker, type NewCustomer } from '../components/CustomerPicker';

type View = 'day' | 'week';
const VIEW_KEY = 'agenda.view';
const ZOOM_KEY = 'agenda.zoom';
/** Height of one hour, per zoom level */
const ZOOMS = [72, 104, 144];
const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
};
const savedView = (): View | null => {
  const v = stored(VIEW_KEY);
  return v === 'week' ? 'week' : v === 'day' || v === 'team' ? 'day' : null;
};
const savedZoom = (): number => {
  const n = Number(stored(ZOOM_KEY));
  return Number.isInteger(n) && n >= 0 && n < ZOOMS.length && stored(ZOOM_KEY) !== null ? n : 1;
};
const SMALL_QUERY = '(max-width: 767px)';
function useSmallScreen() {
  const [small, setSmall] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(SMALL_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(SMALL_QUERY);
    if (!mq) return;
    const on = () => setSmall(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return small;
}
const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
/** Opening range of one schedule in minutes; closing at or before opening means "past midnight". */
const range = (h: BusinessHours): [number, number] => {
  const open = toMin(h.open);
  const close = toMin(h.close);
  return [open, close <= open ? 24 * 60 : close];
};
const BRAND = '#0f766e';
/** "Alejandro Aguilar" -> "Alejandro A." for narrow blocks */
const shortName = (name: string) => {
  const [first, ...rest] = name.trim().split(/\s+/);
  return rest.length ? `${first} ${rest[0]![0]}.` : first ?? name;
};

/**
 * One calendar for every kind of business. Columns are days, or resources (people, courts, tables,
 * instructors) in the day view. Bookings and group classes are blocks on the same grid; the kind
 * only changes labels and which form opens (KIND_CONFIG).
 */
export function AgendaPage() {
  const { t, i18n } = useTranslation();
  const { tenant } = useAuth();
  const kind = tenant?.kind ?? 'appointments';
  const cfg = kindConfig(kind);
  const owesNoShow = noShowOwes(tenant!.settings);
  const { manager, scoped, resourceId, locationId: ownLocation } = useAccess();
  const locs = useMyLocations(ownLocation);
  const small = useSmallScreen();
  const [loc, setLoc] = useState('');
  const resourcesQ = useResources();
  const inLoc = (x: { locationId: string }) => !loc || x.locationId === loc;
  const resources = (resourcesQ.data ?? []).filter((x) => x.active && inLoc(x));
  const [filter, setFilter] = useState('');
  const columnResources = resources.filter((r) => !filter || r.id === filter);
  const byResource = !scoped && resources.length > 1;

  const [viewPref, setViewPref] = useState<View | null>(() => savedView());
  const view: View = viewPref ?? (small ? 'day' : byResource ? 'day' : 'week');
  const setView = (v: View) => {
    setViewPref(v);
    store(VIEW_KEY, v);
  };
  const [zoom, setZoomState] = useState(savedZoom);
  const setZoom = (z: number) => {
    const n = Math.max(0, Math.min(ZOOMS.length - 1, z));
    setZoomState(n);
    store(ZOOM_KEY, String(n));
  };
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [showCancelled, setShowCancelled] = useState(false);
  const [creating, setCreating] = useState<{ at: Date; locationId?: string; resourceId?: string } | null>(null);
  const [selected, setSelected] = useState<AppointmentDto | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const datePicker = useRef<HTMLInputElement>(null);
  const weekStart = startOfWeek(anchor, { weekStartsOn: 1 });
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const today = new Date();
  const loc0 = (l: string) => locs.byId.get(l);
  const hoursOf = (locationId?: string): BusinessHours => (locationId && loc0(locationId)?.hours) || tenant!.settings.hours;
  const visibleLocIds = loc ? [loc] : locs.list.map((l) => l.id);
  const openFor = (date: Date, locIds: string[]): [number, number] | null => {
    const wd = date.getDay() || 7;
    const hs = (locIds.length ? locIds.map(hoursOf) : [tenant!.settings.hours]).filter((h) => h.days.includes(wd));
    if (!hs.length) return null;
    const rs = hs.map(range);
    return [Math.min(...rs.map((r) => r[0])), Math.max(...rs.map((r) => r[1]))];
  };

  /** Closed stretches of a day (minutes) for one or more schedules: open if any of them is open. */
  const closedFor = (date: Date, schedules: HoursValue[]): [number, number][] => {
    const wd = date.getDay() || 7;
    const open = schedules
      .flatMap((h) => intervalsOnWeekday(h, wd))
      .sort((a, b) => a[0] - b[0])
      .reduce<[number, number][]>((acc, [s0, e0]) => {
        const last = acc[acc.length - 1];
        if (last && s0 <= last[1]) last[1] = Math.max(last[1], e0);
        else acc.push([s0, e0]);
        return acc;
      }, []);
    const out: [number, number][] = [];
    let cursor = 0;
    for (const [s0, e0] of open) {
      if (s0 > cursor) out.push([cursor, s0]);
      cursor = Math.max(cursor, e0);
    }
    if (cursor < 24 * 60) out.push([cursor, 24 * 60]);
    return out;
  };
  /** Blocks that apply to a column, clipped to that day, in minutes from midnight. */
  const blocksFor = (date: Date, applies: (b: TimeBlockDto) => boolean): CalBlock[] => {
    const dayStart = startOfDay(date).getTime();
    const dayEnd = addDays(startOfDay(date), 1).getTime();
    return (blocksQ.data ?? [])
      .filter((b) => applies(b) && new Date(b.startsAt).getTime() < dayEnd && new Date(b.endsAt).getTime() > dayStart)
      .map((b) => ({
        id: b.id,
        startMin: Math.max(0, (new Date(b.startsAt).getTime() - dayStart) / 60000),
        endMin: Math.min(24 * 60, (new Date(b.endsAt).getTime() - dayStart) / 60000),
        label: b.reason || t('blocks.blocked'),
        onClick: canBlock ? () => setBlocking(b) : undefined,
      }));
  };
  /** Business-wide or location-wide blocks for the visible locations (resource blocks show in their column). */
  const sharedBlock = (b: TimeBlockDto) => !b.resourceId && (!b.locationId || visibleLocIds.includes(b.locationId));

  // Phones show 3 days instead of a whole week (like Teams mobile).
  const threeDays = useMemo(() => {
    const out: Date[] = [];
    for (let i = 0; out.length < 3 && i < 14; i++) {
      const d = addDays(anchor, i);
      if (openFor(d, visibleLocIds) || i === 0) out.push(d);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, loc, locs.list.length, tenant]);
  const multiDay = view === 'week' ? (small ? threeDays : weekDays) : [anchor];
  const from = new Date(Math.min(weekStart.getTime(), multiDay[0]!.getTime()));
  const to = new Date(Math.max(addDays(weekStart, 7).getTime(), addDays(multiDay[multiDay.length - 1]!, 1).getTime()));
  const range$ = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;

  const apptsQ = useQuery({
    queryKey: ['appointments', from.toISOString(), to.toISOString()],
    queryFn: () => api<AppointmentDto[]>(`/appointments?${range$}`),
  });
  const sessionsQ = useQuery({
    queryKey: ['class-sessions', from.toISOString(), to.toISOString()],
    queryFn: () => api<ClassSessionDto[]>(`/class-sessions?${range$}`),
    enabled: cfg.sessions,
  });
  const blocksQ = useQuery({
    queryKey: ['time-blocks', from.toISOString(), to.toISOString()],
    queryFn: () => api<TimeBlockDto[]>(`/time-blocks?${range$}`),
  });
  const [blocking, setBlocking] = useState<TimeBlockDto | 'new' | null>(null);
  const canBlock = manager || Boolean(resourceId);
  const isLoading = apptsQ.isLoading || (cfg.sessions && sessionsQ.isLoading);

  const fmtTime = (d: Date) => format(d, i18n.language.startsWith('en') ? 'h:mm a' : 'HH:mm');
  const fmtRange = (s: Date, e: Date) => `${fmtTime(s)} – ${fmtTime(e)}`;

  /** Everything on the calendar, as one list: bookings, and classes (their sign-ups are inside). */
  type Item = { start: Date; resourceId: string | null; locationId: string; toEvent: (showResource: boolean) => CalEvent };
  const items: Item[] = [
    ...(apptsQ.data ?? [])
      .filter((a) => !a.classSessionId && (showCancelled || a.status !== 'cancelled'))
      .map((a): Item => ({
        start: new Date(a.startsAt),
        resourceId: a.resourceId,
        locationId: a.locationId,
        toEvent: (showResource) => {
          const start = new Date(a.startsAt);
          const end = new Date(a.endsAt);
          const sub = cfg.partySize && a.partySize ? t('agenda.attendees', { count: a.partySize }) : a.serviceName;
          return {
            id: a.id,
            start,
            end,
            color: a.resourceColor ?? BRAND,
            title: a.customerName,
            shortTitle: shortName(a.customerName),
            subtitle: sub,
            detail: showResource ? a.resourceName : null,
            icon: BOOKING_ICON[a.status],
            badge: (() => {
              const ps = paymentState(a, { noShowOwes: owesNoShow });
              return ps === 'free' || a.status === 'cancelled' ? undefined : { text: PAYMENT_PILL_TEXT[ps], className: PAYMENT_PILL[ps] };
            })(),
            tone: a.status === 'cancelled' ? 'cancelled' : a.status === 'no_show' ? 'alert' : a.status === 'completed' ? 'muted' : 'normal',
            label: [
              fmtRange(start, end),
              a.customerName,
              sub,
              a.resourceName,
              t(`status.${a.status}`),
              paymentState(a, { noShowOwes: owesNoShow }) !== 'free' && t(`payState.${paymentState(a, { noShowOwes: owesNoShow })}`),
            ].filter(Boolean).join(' · '),
            onClick: () => setSelected(a),
          };
        },
      })),
    ...(sessionsQ.data ?? [])
      .filter((s) => showCancelled || s.status !== 'cancelled')
      .map((s): Item => ({
        start: new Date(s.startsAt),
        resourceId: s.resourceId,
        locationId: s.locationId,
        toEvent: (showResource) => {
          const start = new Date(s.startsAt);
          const end = new Date(s.endsAt);
          const cancelled = s.status === 'cancelled';
          const spots = cancelled ? t('classes.cancelled') : `${s.booked}/${s.capacity} · ${t('agenda.attendees', { count: s.booked })}`;
          return {
            id: `class-${s.id}`,
            start,
            end,
            color: s.resourceColor ?? BRAND,
            title: s.serviceName,
            subtitle: spots,
            detail: showResource ? s.resourceName : null,
            icon: !cancelled && s.booked >= s.capacity ? '●' : '',
            tone: cancelled ? 'cancelled' : 'normal',
            label: [fmtRange(start, end), s.serviceName, spots, s.resourceName].filter(Boolean).join(' · '),
            onClick: () => setSession(s.id),
          };
        },
      })),
  ].filter((x) => inLoc(x) && (!filter || x.resourceId === filter));

  const onDay = (d: Date) => items.filter((x) => isSameDay(x.start, d));
  const countOn = (d: Date) => onDay(d).length;
  const openDay = (d: Date) => {
    setAnchor(startOfDay(d));
    setView('day');
  };
  const dayHeader = (d: Date, clickable: boolean) => {
    const isToday = isSameDay(d, today);
    const count = countOn(d);
    const inner = (
      <>
        <span className={`text-xs font-semibold uppercase tracking-wide ${isToday ? 'text-brand-700' : 'text-slate-500'}`}>
          {format(d, 'EEE', { locale: dateLocale() })}
        </span>
        <span className={`flex h-9 w-9 items-center justify-center rounded-full text-xl font-semibold ${isToday ? 'bg-brand-700 text-white' : 'text-slate-800'}`}>
          {format(d, 'd')}
        </span>
        <span className="text-xs text-slate-500">{count ? t('agenda.count', { count }) : ' '}</span>
      </>
    );
    return clickable ? (
      <button type="button" className="flex w-full flex-col items-center rounded-md hover:bg-slate-50" onClick={() => openDay(d)} aria-label={format(d, 'PPPP', { locale: dateLocale() })}>
        {inner}
      </button>
    ) : (
      <div className="flex flex-col items-center">{inner}</div>
    );
  };
  // Classes are scheduled by managers; bookings by anyone.
  const canCreate = !cfg.sessions || manager;
  const newAt = (at: Date, locationId?: string, resourceId?: string) => setCreating({ at, locationId: locationId ?? loc, resourceId });
  // Home-screen shortcut "Nueva cita" (/agenda?new=1) opens the form once.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('new') !== '1' || !canCreate) return;
    q.delete('new');
    window.history.replaceState(null, '', `${window.location.pathname}${q.toString() ? `?${q}` : ''}`);
    const at = new Date();
    at.setMinutes(at.getMinutes() < 30 ? 30 : 60, 0, 0);
    setCreating({ at, locationId: loc });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  let columns: CalColumn[];
  if (view === 'day' && byResource) {
    const day = onDay(anchor);
    columns = columnResources.map((r) => {
      const events = day.filter((x) => x.resourceId === r.id).map((x) => x.toEvent(false));
      return {
        key: r.id,
        date: anchor,
        isToday: false,
        open: openFor(anchor, [r.locationId]),
        closed: closedFor(anchor, [r.hours ?? hoursOf(r.locationId)]),
        blocks: blocksFor(anchor, (b) => b.resourceId === r.id || (!b.resourceId && (!b.locationId || b.locationId === r.locationId))),
        events,
        onCreate: canCreate ? (at: Date) => newAt(at, r.locationId, r.id) : undefined,
        header: (
          <div className="flex min-w-0 flex-col items-center px-1 text-center">
            <span className="flex max-w-full items-center gap-2 text-sm font-semibold text-slate-800">
              <span className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: r.color }} />
              <span className="truncate">{r.name}</span>
            </span>
            <span className="truncate text-xs text-slate-500">
              {[
                r.capacity != null ? t('resources.capacityN', { count: r.capacity }) : '',
                locs.multi && !loc ? loc0(r.locationId)?.name : '',
                t('agenda.count', { count: events.length }),
              ].filter(Boolean).join(' · ')}
            </span>
          </div>
        ),
      };
    });
    const unassigned = day.filter((x) => !x.resourceId || !columnResources.some((r) => r.id === x.resourceId));
    if (unassigned.length && !filter) {
      columns.push({
        key: 'unassigned',
        date: anchor,
        isToday: false,
        open: openFor(anchor, visibleLocIds),
        events: unassigned.map((x) => x.toEvent(true)),
        onCreate: canCreate ? (at) => newAt(at) : undefined,
        header: (
          <div className="flex flex-col items-center text-center">
            <span className="text-sm font-semibold text-slate-600">{t('agenda.unassigned')}</span>
            <span className="text-xs text-slate-500">{t('agenda.count', { count: unassigned.length })}</span>
          </div>
        ),
      });
    }
    // The red "now" line goes across every column of today.
    if (isSameDay(anchor, today)) columns = columns.map((c) => ({ ...c, isToday: true }));
  } else {
    // Week view shows the days the business opens (plus any day that has bookings).
    const days =
      view === 'day' || small
        ? multiDay
        : weekDays.filter((d) => openFor(d, visibleLocIds) || onDay(d).length > 0).length
          ? weekDays.filter((d) => openFor(d, visibleLocIds) || onDay(d).length > 0)
          : weekDays;
    const showResource = !filter && resources.length > 1;
    columns = days.map((d) => ({
      key: d.toISOString(),
      date: d,
      isToday: isSameDay(d, today),
      open: openFor(d, visibleLocIds),
      closed: filter
        ? closedFor(d, [columnResources[0]?.hours ?? hoursOf(columnResources[0]?.locationId)])
        : closedFor(d, visibleLocIds.length ? visibleLocIds.map(hoursOf) : [tenant!.settings.hours]),
      blocks: blocksFor(d, (b) => sharedBlock(b) || (filter !== '' && b.resourceId === filter) || (scoped && b.resourceId === resourceId)),
      events: onDay(d).map((x) => x.toEvent(showResource)),
      onCreate: canCreate ? (at: Date) => newAt(at) : undefined,
      onMore: () => openDay(d),
      header: dayHeader(d, view === 'week'),
    }));
  }

  // Visible hours: from the earliest opening to the latest closing, stretched to fit bookings.
  const allHours = (visibleLocIds.length ? visibleLocIds.map(hoursOf) : [tenant!.settings.hours]).map(range);
  const evMins = columns.flatMap((c) => c.events.flatMap((e) => [e.start.getHours() * 60 + e.start.getMinutes(), e.end.getHours() * 60 + e.end.getMinutes() || 24 * 60]));
  const startMin = Math.max(0, Math.floor(Math.min(...allHours.map((r) => r[0]), ...evMins) / 60) * 60);
  const endMin = Math.min(24 * 60, Math.ceil(Math.max(...allHours.map((r) => r[1]), ...evMins, startMin + 8 * 60) / 60) * 60);

  const step = view === 'week' ? (small ? 3 : 7) : 1;
  const first = multiDay[0]!;
  const last = multiDay[multiDay.length - 1]!;
  const rangeLabel =
    view === 'week'
      ? `${format(small ? first : weekStart, 'd MMM', { locale: dateLocale() })} – ${format(small ? last : addDays(weekStart, 6), 'd MMM yyyy', { locale: dateLocale() })}`
      : format(anchor, t('agenda.dayFormat'), { locale: dateLocale() });
  const views: [View, string][] = [['day', t('agenda.viewDay')], ['week', small ? t('agenda.viewThreeDays') : t('agenda.viewWeek')]];
  const pickDate = () => {
    const el = datePicker.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
      el.click();
    }
  };
  const segBtn = (active: boolean) =>
    `rounded-md px-3 py-1 text-sm font-medium ${active ? 'bg-brand-700 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'} disabled:opacity-40`;

  return (
    <>
      <PageHeader
        title={t(`kinds.${kind}.calendar`)}
        actions={
          <div className="flex flex-wrap gap-2">
          {canBlock && (
            <button className="btn-secondary" onClick={() => setBlocking('new')}>
              🔒 {t('blocks.add')}
            </button>
          )}
          {canCreate && (
            <button className="btn-primary" onClick={() => {
              const at = isSameDay(anchor, today) ? new Date() : new Date(new Date(anchor).setHours(10, 0, 0, 0));
              at.setMinutes(Math.ceil(at.getMinutes() / 30) * 30, 0, 0);
              newAt(at);
            }}>
              {t(`kinds.${kind}.newBooking`)}
            </button>
          )}
          </div>
        }
      />
      {scoped && <p className="mb-2 text-sm text-slate-500">{t('roles.onlyYours')}</p>}

      {/* Toolbar (Teams style): today, prev/next, date picker | filters, view, zoom */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button className="btn-secondary !px-3 !py-1.5" onClick={() => setAnchor(startOfDay(new Date()))}>{t('agenda.today')}</button>
        <div className="flex">
          <button className="btn-secondary !rounded-r-none !px-3 !py-1.5 text-lg leading-none" onClick={() => setAnchor(addDays(anchor, -step))} aria-label={t('agenda.prev')}>‹</button>
          <button className="btn-secondary !-ml-px !rounded-l-none !px-3 !py-1.5 text-lg leading-none" onClick={() => setAnchor(addDays(anchor, step))} aria-label={t('agenda.next')}>›</button>
        </div>
        <div className="relative min-w-0">
          <button
            type="button"
            onClick={pickDate}
            className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-base font-semibold text-slate-800 hover:bg-slate-100 sm:text-lg"
            aria-label={t('agenda.pickDate')}
          >
            <span className="truncate first-letter:uppercase">{rangeLabel}</span>
            <span className="text-sm text-slate-400" aria-hidden>▾</span>
          </button>
          <input
            ref={datePicker}
            type="date"
            tabIndex={-1}
            aria-hidden
            className="pointer-events-none absolute bottom-0 left-2 h-0 w-0 opacity-0"
            value={format(anchor, 'yyyy-MM-dd')}
            onChange={(e) => {
              if (!e.target.value) return;
              const [y, m, d] = e.target.value.split('-').map(Number);
              setAnchor(new Date(y!, (m ?? 1) - 1, d ?? 1));
            }}
          />
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 md:ml-auto md:w-auto">
          {!scoped && locs.multi && (
            <select className="input !w-auto !py-1.5 text-sm" aria-label={t('locations.location')} value={loc} onChange={(e) => { setLoc(e.target.value); setFilter(''); }}>
              <option value="">{t('locations.all')}</option>
              {locs.list.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          )}
          {!scoped && resources.length > 1 && (
            <select className="input !w-auto !py-1.5 text-sm" aria-label={t('agenda.filter')} value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">{t(`kinds.${kind}.allResources`)}</option>
              {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
          <label className="hidden items-center gap-1.5 text-sm text-slate-600 lg:flex">
            <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
            {t('agenda.showCancelled')}
          </label>
          <div className="ml-auto flex items-center gap-2">
            <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5" role="group" aria-label={t('agenda.view')}>
              {views.map(([v, label]) => (
                <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)} className={segBtn(view === v)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5" role="group" aria-label={t('agenda.zoom')}>
              <button type="button" className={segBtn(false)} onClick={() => setZoom(zoom - 1)} disabled={zoom === 0} aria-label={t('agenda.zoomOut')}>−</button>
              <button type="button" className={segBtn(false)} onClick={() => setZoom(zoom + 1)} disabled={zoom === ZOOMS.length - 1} aria-label={t('agenda.zoomIn')}>+</button>
            </div>
          </div>
        </div>
      </div>

      {/* Phones, day view: week strip to jump between days */}
      {view === 'day' && small && (
        <div className="-mx-1 mb-2 flex gap-1 overflow-x-auto px-1 pb-1" role="group" aria-label={t('agenda.pickDay')}>
          {weekDays.map((d) => {
            const sel = isSameDay(d, anchor);
            const n = countOn(d);
            return (
              <button
                key={d.toISOString()}
                type="button"
                onClick={() => setAnchor(startOfDay(d))}
                aria-pressed={sel}
                className={`flex min-w-[2.75rem] flex-1 flex-col items-center rounded-lg border px-1 py-1 ${sel ? 'border-brand-700 bg-brand-700 text-white' : isSameDay(d, today) ? 'border-brand-500 bg-white text-brand-700' : 'border-slate-200 bg-white text-slate-700'}`}
              >
                <span className="text-[11px] font-medium uppercase">{format(d, 'EEE', { locale: dateLocale() })}</span>
                <span className="text-base font-semibold leading-tight">{format(d, 'd')}</span>
                <span className={`text-[10px] ${sel ? 'text-white/80' : 'text-slate-400'}`}>{n || '·'}</span>
              </button>
            );
          })}
        </div>
      )}

      {isLoading ? (
        <Loading />
      ) : columns.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">{t('agenda.empty')}</p>
      ) : (
        <CalendarGrid
          columns={columns}
          startMin={startMin}
          endMin={endMin}
          maxLanes={view === 'week' ? 2 : 3}
          minColWidth={view === 'week' ? (small ? 112 : 150) : columns.length > 1 ? (small ? 156 : 184) : 220}
          pxPerHour={ZOOMS[zoom]!}
          compact={small}
          slotMinutes={tenant?.settings.hours.slotMinutes ?? 30}
          formatHour={(h) => (i18n.language.startsWith('en') ? format(new Date(2000, 0, 1, h), 'h a') : `${String(h).padStart(2, '0')}:00`)}
          formatRange={fmtRange}
          formatTime={fmtTime}
          createLabel={t('agenda.tapToCreate')}
          moreLabel={(n) => t('agenda.more', { count: n })}
        />
      )}
      <StatusLegend />
      {canCreate && <p className="mt-1 hidden text-xs text-slate-500 sm:block">{t('agenda.tapToCreate')}</p>}

      {creating &&
        (cfg.sessions ? (
          <NewSessionModal initial={creating.at} defaultLocation={creating.locationId ?? loc} resourceId={creating.resourceId} onClose={() => setCreating(null)} />
        ) : (
          <NewAppointmentModal initial={creating.at} defaultLocation={creating.locationId ?? loc} presetResource={creating.resourceId} onClose={() => setCreating(null)} />
        ))}
      {selected && <AppointmentModal appt={selected} onClose={() => setSelected(null)} />}
      {blocking && (
        <BlockModal
          block={blocking === 'new' ? null : blocking}
          initialDay={anchor}
          resources={resources}
          presetResource={scoped ? resourceId : filter || null}
          onClose={() => setBlocking(null)}
        />
      )}
      {session && <SessionModal id={session} onClose={() => setSession(null)} onOpen={setSession} />}
    </>
  );
}

/** Label for a resource in pickers: name plus what makes it different (seats, hourly rate). */
function useResourceLabel() {
  const { t } = useTranslation();
  return (r: ResourceDto) =>
    [
      r.name,
      r.capacity != null && t('resources.capacityN', { count: r.capacity }),
      r.pricePerHourCents != null && t('resources.perHour', { price: money(r.pricePerHourCents) }),
    ]
      .filter(Boolean)
      .join(' · ');
}

function NewAppointmentModal({ initial, defaultLocation, presetResource, onClose }: { initial: Date; defaultLocation: string; presetResource?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { tenant, user } = useAuth();
  const kind = tenant?.kind ?? 'appointments';
  const cfg = kindConfig(kind);
  // Colaboradores book into their own agenda; the API enforces it too.
  const { scoped, resourceId: ownResource, locationId: ownLocation } = useAccess();
  const locs = useMyLocations(ownLocation);
  const [locationId, setLocationId] = useState(defaultLocation || ownLocation || '');
  // With one location there's nothing to choose; the API uses the main one.
  const effectiveLoc = locationId || locs.list[0]?.id || '';
  const resourcesQ = useResources();
  const label = useResourceLabel();
  const durations = rentalSettingsOf(tenant!.settings).durations;
  // Kinds that book by party size or by length use one internal service.
  const needsService = !cfg.partySize && !cfg.durations;
  const [resourceId, setResourceId] = useState(presetResource ?? '');
  const [partySize, setPartySize] = useState('2');
  const services = useServices();
  const [customerId, setCustomerId] = useState('');
  const [newCustomer, setNewCustomer] = useState<NewCustomer | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [day, setDay] = useState(format(initial, 'yyyy-MM-dd'));
  const [time, setTime] = useState(format(initial, 'HH:mm'));
  const [duration, setDuration] = useState(cfg.durations ? String(durations[0]) : '');
  const [price, setPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const [allowOverlap, setAllowOverlap] = useState(false);
  const [couponCode, setCouponCode] = useState('');
  const couponsOn = couponsEnabled(tenant!.settings);
  const rewardsOn = rewardSettingsOf(tenant!.settings).enabled;

  const active = (services.data ?? []).filter((s) => s.active);
  const svc = active.find((s) => s.id === serviceId);
  const atLoc = (resourcesQ.data ?? []).filter((r) => r.active && (!effectiveLoc || r.locationId === effectiveLoc));
  const eligible = eligibleResources(atLoc, { serviceId: needsService ? serviceId || null : null, partySize: cfg.partySize ? Number(partySize || 1) : null });
  const resource = atLoc.find((r) => r.id === resourceId);
  const durationMin = Number(duration || svc?.durationMin || 0);
  const suggested = bookingPriceCents(resource, svc?.priceCents ?? 0, durationMin);
  const startsAt = day && time ? new Date(`${day}T${time}`) : null;
  const effectiveResource = scoped ? ownResource : resourceId || null;

  // Checks the time while you fill the form, so a taken slot shows up before saving.
  const checkBody = startsAt && !Number.isNaN(startsAt.getTime()) && (!needsService || serviceId)
    ? {
        serviceId: needsService ? serviceId : undefined,
        startsAt: startsAt.toISOString(),
        durationMin: duration ? Number(duration) : undefined,
        ...(cfg.partySize ? { partySize: Number(partySize) || 1 } : {}),
        resourceId: effectiveResource,
        ...(!scoped && effectiveLoc ? { locationId: effectiveLoc } : {}),
      }
    : null;
  const [debouncedCheck, setDebouncedCheck] = useState(checkBody);
  const checkKey = JSON.stringify(checkBody);
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedCheck(checkBody), 300);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey]);
  const check = useQuery({
    queryKey: ['availability-check', JSON.stringify(debouncedCheck)],
    queryFn: () => api<AvailabilityCheckDto>('/appointments/check', { method: 'POST', body: debouncedCheck }),
    enabled: Boolean(debouncedCheck),
    staleTime: 10_000,
  });
  const taken = check.data && !check.data.free && JSON.stringify(debouncedCheck) === checkKey ? check.data : null;
  useEffect(() => setAllowOverlap(false), [checkKey]);

  // Reward every N visits / coupon: shown before saving; the API applies the same rule.
  const basePrice = price !== '' ? toCents(price) : suggested;
  const [debouncedCode, setDebouncedCode] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedCode(couponCode.trim()), 400);
    return () => window.clearTimeout(id);
  }, [couponCode]);
  const discount = useQuery({
    queryKey: ['discount-preview', customerId, debouncedCode, basePrice],
    queryFn: () => api<DiscountPreviewDto>('/appointments/discount', { method: 'POST', body: { customerId: customerId || null, couponCode: debouncedCode || undefined, priceCents: basePrice } }),
    enabled: (rewardsOn && Boolean(customerId)) || (couponsOn && debouncedCode.length >= 3),
  });
  const d = discount.data;

  const create = useMutation({
    mutationFn: async () => {
      let cid = customerId;
      if (newCustomer) {
        const c = await api<CustomerDto>('/customers', {
          method: 'POST',
          body: { name: newCustomer.name, phone: newCustomer.phone || null },
        });
        cid = c.id;
      }
      return api<AppointmentDto>('/appointments', {
        method: 'POST',
        body: {
          customerId: cid,
          serviceId: needsService ? serviceId || active[0]?.id : undefined,
          startsAt: startsAt!.toISOString(),
          durationMin: duration ? Number(duration) : undefined,
          priceCents: price !== '' ? toCents(price) : undefined,
          notes: notes || null,
          allowOverlap,
          ...(couponsOn && couponCode.trim() && !d?.couponError ? { couponCode: couponCode.trim() } : {}),
          ...(cfg.partySize ? { partySize: Number(partySize) } : {}),
          ...(scoped ? { resourceId: ownResource } : atLoc.length ? { resourceId: resourceId || null } : {}),
          ...(!scoped && effectiveLoc ? { locationId: effectiveLoc } : {}),
        },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['appointments'] });
      void qc.invalidateQueries({ queryKey: ['customers'] });
      void qc.invalidateQueries({ queryKey: ['dashboard'] });
      void qc.invalidateQueries({ queryKey: ['collections'] });
      onClose();
    },
  });

  const pickService = (id: string) => {
    setServiceId(id);
    const s = active.find((x) => x.id === id);
    if (s) {
      setDuration(String(s.durationMin));
      setPrice('');
    }
  };
  const resName = (id: string) => atLoc.find((r) => r.id === id)?.name ?? '';
  const section = 'space-y-3 border-t border-slate-100 pt-4 first:border-0 first:pt-0';

  return (
    <Modal open title={t(`kinds.${kind}.newBooking`)} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {/* Who */}
        <div className={section}>
          <label className="label !mb-0">{t('agenda.customer')}</label>
          <CustomerPicker value={customerId} onChange={setCustomerId} forBooking={scoped} newCustomer={newCustomer} onNewCustomer={setNewCustomer} />
        </div>

        {/* What and where */}
        <div className={section}>
          {!scoped && locs.multi && (
            <div>
              <label className="label" htmlFor="na-loc">{t('locations.location')}</label>
              <LocationSelect id="na-loc" value={effectiveLoc} onChange={(v) => { setLocationId(v); setResourceId(''); }} list={locs.list} />
            </div>
          )}
          {needsService && (
            <div>
              <label className="label" htmlFor="na-svc">{t('agenda.service')}</label>
              <select id="na-svc" required className="input" value={serviceId} onChange={(e) => pickService(e.target.value)}>
                <option value="">{t('agenda.selectService')}</option>
                {active.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} · {s.durationMin} {t('common.minutes')} · {money(s.priceCents)}</option>
                ))}
              </select>
            </div>
          )}
          {(cfg.partySize || scoped || atLoc.length > 0) && (
            <div className="grid grid-cols-2 gap-3">
              {scoped ? (
                <p className="col-span-2 text-sm text-slate-500">{t('roles.bookingFor', { name: atLoc.find((r) => r.id === ownResource)?.name ?? user?.name })}</p>
              ) : atLoc.length > 0 && (
                <div className={cfg.partySize ? '' : 'col-span-2'}>
                  <label className="label" htmlFor="na-res">{t(`kinds.${kind}.resource`)}</label>
                  <select id="na-res" className="input" value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
                    <option value="">{t('resources.auto')}</option>
                    {eligible.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
                  </select>
                </div>
              )}
              {cfg.partySize && (
                <div>
                  <label className="label" htmlFor="na-party">{t('agenda.partySize')}</label>
                  <input id="na-party" type="number" min={1} max={50} required className="input" value={partySize} onChange={(e) => setPartySize(e.target.value)} />
                </div>
              )}
            </div>
          )}
        </div>

        {/* When */}
        <div className={section}>
          <div className="grid grid-cols-[1.4fr_1fr_1fr] gap-3">
            <div>
              <label className="label" htmlFor="na-day">{t('agenda.day')}</label>
              <input id="na-day" type="date" required className="input" value={day} onChange={(e) => setDay(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="na-time">{t('agenda.time')}</label>
              <input id="na-time" type="time" required step={300} className="input" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor="na-dur">{t('agenda.duration')}</label>
              {cfg.durations ? (
                <select id="na-dur" className="input" value={duration} onChange={(e) => setDuration(e.target.value)}>
                  {durations.map((m) => <option key={m} value={m}>{m} {t('common.minutes')}</option>)}
                </select>
              ) : (
                <input id="na-dur" type="number" min={5} className="input" placeholder={svc ? String(svc.durationMin) : ''} value={duration} onChange={(e) => setDuration(e.target.value)} />
              )}
            </div>
          </div>
          {taken ? (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm" role="alert" data-testid="slot-taken">
              <p className="font-medium text-rose-800">
                {t(`agenda.taken.${['blocked', 'resource_busy', 'no_resource_available'].includes(taken.reason ?? '') ? taken.reason : 'overlap'}`, { name: resource?.name ?? '' })}
              </p>
              {(taken.freeResources.length > 0 || taken.times.length > 0) && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-slate-600">{t('agenda.taken.try')}</span>
                  {taken.freeResources.map((r) => (
                    <button key={r.id} type="button" className="rounded-full border border-emerald-300 bg-white px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-50" onClick={() => setResourceId(r.id)}>
                      {resName(r.id) || r.name} · {time}
                    </button>
                  ))}
                  {taken.times.map((iso) => (
                    <button key={iso} type="button" className="rounded-full border border-emerald-300 bg-white px-2.5 py-1 text-xs font-medium text-emerald-800 hover:bg-emerald-50" onClick={() => setTime(format(new Date(iso), 'HH:mm'))}>
                      {timeOnly(iso)}
                    </button>
                  ))}
                </div>
              )}
              {!scoped && (
                <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
                  <input type="checkbox" checked={allowOverlap} onChange={(e) => setAllowOverlap(e.target.checked)} />
                  {t('agenda.allowOverlap')}
                </label>
              )}
            </div>
          ) : check.data?.free && JSON.stringify(debouncedCheck) === checkKey ? (
            <p className="text-sm text-emerald-700" data-testid="slot-free">✓ {t('agenda.slotFree')}</p>
          ) : null}
        </div>

        {/* Price and notes */}
        <div className={section}>
          <div className="flex items-end gap-3">
            <div className="w-36">
              <label className="label" htmlFor="na-price">{t('agenda.price')}</label>
              <input
                id="na-price"
                type="number"
                min={0}
                step="0.01"
                className="input"
                placeholder={suggested ? String(suggested / 100) : t('common.optional')}
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </div>
            {couponsOn && (
              <div className="w-36">
                <label className="label" htmlFor="na-coupon">{t('promos.coupon')}</label>
                <input id="na-coupon" className="input uppercase" placeholder={t('common.optional')} value={couponCode} onChange={(e) => setCouponCode(e.target.value)} />
              </div>
            )}
            {!showNotes && (
              <button type="button" className="pb-2.5 text-sm font-medium text-brand-700 hover:underline" onClick={() => setShowNotes(true)}>
                + {t('agenda.addNote')}
              </button>
            )}
          </div>
          {d && (d.discountCents > 0 || d.couponError || d.reward) && (
            <div className="space-y-1 text-sm" data-testid="discount-preview">
              {d.discountCents > 0 ? (
                <p className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">
                  {d.reason === 'reward'
                    ? `🎁 ${t('promos.rewardEarned', { count: d.reward?.visitsSince ?? 0 })}`
                    : `🏷️ ${t('promos.couponApplied')} ${d.couponCode}`}
                  : −{money(d.discountCents)} → <b>{money(basePrice - d.discountCents)}</b>
                </p>
              ) : d.reward && !d.reward.eligible && customerId ? (
                <p className="text-xs text-slate-500">🎁 {t('promos.rewardProgress', { done: d.reward.visitsSince, every: d.reward.everyVisits })}</p>
              ) : null}
              {d.couponError && <p className="text-xs text-rose-700">{t(`errors.${d.couponError}`)}</p>}
            </div>
          )}
          {showNotes && (
            <textarea id="na-notes" className="input" rows={2} autoFocus placeholder={t('agenda.notesPlaceholder')} aria-label={t('agenda.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} />
          )}
        </div>

        <ErrorText error={create.error} ns="agenda" />
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={create.isPending || (Boolean(taken) && !allowOverlap)}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  );
}

/** After "Asistió": take the session from a package/membership, or charge normally. */
function PlanUse({ appt, onChanged }: { appt: AppointmentDto; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['appt-plans', appt.id, appt.status],
    queryFn: () => api<{ choices: PlanChoiceDto[]; usedPlanId: string | null; usedPlanName: string | null }>(`/appointments/${appt.id}/plans`),
  });
  const [pick, setPick] = useState('');
  const use = useMutation({
    mutationFn: (planId: string | null) => api(`/appointments/${appt.id}/use-plan`, { method: 'POST', body: { planId } }),
    onSuccess: async () => {
      await q.refetch();
      await onChanged();
    },
  });
  const d = q.data;
  if (!d || (!d.usedPlanId && !d.choices.length)) return null;
  return (
    <div className="mt-3 border-t border-slate-200 pt-3 text-center" data-testid="plan-use">
      {d.usedPlanId ? (
        <p className="text-sm text-emerald-800">
          🎟️ {t('sales.takenFrom', { name: d.usedPlanName })}{' '}
          <button type="button" className="text-xs text-slate-600 underline" onClick={() => use.mutate(null)}>{t('sales.chargeNormally')}</button>
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="text-sm">🎟️ {t('sales.hasPlan')}</span>
          <select className="input !w-auto !py-1.5" value={pick || d.choices[0]!.id} onChange={(e) => setPick(e.target.value)} aria-label={t('sales.whichPlan')}>
            {d.choices.map((c) => (
              <option key={c.id} value={c.id}>{c.name} · {c.sessionsLeft == null ? t('sales.unlimited') : t('sales.left', { count: c.sessionsLeft })}</option>
            ))}
          </select>
          <button type="button" className="btn-primary !py-1.5" disabled={use.isPending} onClick={() => use.mutate(pick || d.choices[0]!.id)}>{t('sales.takeSession')}</button>
        </div>
      )}
      <ErrorText error={use.error} ns="sales" />
    </div>
  );
}

function AppointmentModal({ appt, onClose }: { appt: AppointmentDto; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { tenant } = useAuth();
  const { manager, scoped } = useAccess();
  const apptLocs = useMyLocations(null);
  const pay = paymentSettingsOf(tenant!.settings);
  const inPerson = (['cash', 'card', 'transfer'] as const).filter((m) => pay.methods[m]);
  const offline = inPerson.length ? inPerson : (['cash', 'card', 'transfer'] as const);
  const online = tenant?.mercadoPago.connected
    ? (['mercadopago', 'spei'] as const).filter((m) => pay.methods[m])
    : [];
  const selfService = selfServiceOf(tenant!.settings);
  const kind = tenant?.kind ?? 'appointments';
  const cfg = kindConfig(kind);
  const label = useResourceLabel();
  const resourcesQ = useResources();
  const atLoc = (resourcesQ.data ?? []).filter((r) => r.active && r.locationId === appt.locationId);
  // Party size kinds (restaurants) charge the bill when the visit ends.
  const withParty = cfg.partySize && appt.partySize != null && !appt.classSessionId;
  const eligible = (party: number | null) => eligibleResources(atLoc, { serviceId: appt.serviceId, partySize: withParty ? party : null });
  const manageUrl = `${window.location.origin}${appt.managePath}`;
  const manageMsg = t('agenda.manageMessage', {
    name: appt.customerName.split(' ')[0],
    business: tenant!.name,
    date: dateTime(appt.startsAt),
    url: manageUrl,
  });
  const [copied, setCopied] = useState(false);

  // The window shows the latest copy of the booking after every change made from it.
  const [cur, setCur] = useState(appt);
  const status = cur.status;
  const outstanding = Math.max(cur.priceCents - cur.paidCents, 0);
  const open = status === 'scheduled' || status === 'confirmed';

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['appointments'] });
    void qc.invalidateQueries({ queryKey: ['customers'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['payments'] });
    void qc.invalidateQueries({ queryKey: ['collections'] });
  };
  /** Re-reads the booking (payments change paidCents and methods). */
  const reload = async () => {
    const fresh = await api<AppointmentDto>(`/appointments/${cur.id}`).catch(() => null);
    if (fresh) setCur(fresh);
  };

  // Every inline edit goes through here; the window stays open so you can keep going.
  const [editing, setEditing] = useState<null | 'time' | 'resource' | 'party' | 'pay' | 'deposit'>(null);
  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<AppointmentDto>(`/appointments/${cur.id}`, { method: 'PATCH', body }),
    onSuccess: (a) => {
      setCur(a);
      setWhen(toLocalInput(new Date(a.startsAt)));
      setEditing(null);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/appointments/${cur.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });

  // Time
  const [when, setWhen] = useState(toLocalInput(new Date(appt.startsAt)));
  // Party size / bill / payment
  const [party, setParty] = useState(String(appt.partySize ?? 2));
  const [method, setMethod] = useState<'cash' | 'card' | 'transfer' | 'gift_card'>(offline[0]!);
  const [giftCode, setGiftCode] = useState('');
  const packagesOn = PLAN_LIMITS[tenant!.plan].packages;
  const [amount, setAmount] = useState('');
  const recordPay = useMutation({
    mutationFn: async () => {
      let price = cur.priceCents;
      // Restaurants: the amount typed is the bill when no price was set yet.
      if (withParty && price === 0) {
        price = toCents(amount);
        await api(`/appointments/${cur.id}`, { method: 'PATCH', body: { priceCents: price } });
      }
      const cents = withParty && cur.priceCents === 0 ? price - cur.paidCents : toCents(amount);
      if (cents > 0) {
        if (method === 'gift_card') {
          // Takes it from the gift card balance
          await api('/gift-cards/redeem', { method: 'POST', body: { code: giftCode.trim(), appointmentId: cur.id, amountCents: cents } });
        } else {
          await api('/payments', { method: 'POST', body: { customerId: cur.customerId, appointmentId: cur.id, amountCents: cents, method } });
        }
      }
    },
    onSuccess: async () => {
      setEditing(null);
      refresh();
      await reload();
    },
  });
  const startPay = () => {
    setAmount(outstanding > 0 ? String(outstanding / 100) : '');
    setEditing('pay');
  };

  // Mercado Pago deposit link
  const [deposit, setDeposit] = useState<{ amount: string; method: 'mercadopago' | 'spei' } | null>(null);
  const [link, setLink] = useState<PaymentDto | null>(null);
  const createLink = useMutation({
    mutationFn: () =>
      api<PaymentDto>('/payments/link', {
        method: 'POST',
        body: { appointmentId: cur.id, amountCents: toCents(deposit!.amount), method: deposit!.method },
      }),
    onSuccess: (p) => {
      setLink(p);
      refresh();
    },
  });

  // Notes save by themselves (shortly after typing, and when the window closes) so nothing is lost.
  const [notes, setNotes] = useState(appt.notes ?? '');
  const [rating, setRating] = useState<number | null>(appt.rating);
  const savedNotes = useRef(appt.notes ?? '');
  const pendingNotes = useRef<string | null>(null);
  const [noteState, setNoteState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveNotes = useMutation({
    mutationFn: (body: { notes?: string | null; rating?: number | null }) =>
      api<AppointmentDto>(`/appointments/${appt.id}`, { method: 'PATCH', body }),
    onSuccess: () => refresh(),
  });
  const flushNotes = (value = pendingNotes.current) => {
    if (value === null || value === savedNotes.current) return;
    pendingNotes.current = null;
    setNoteState('saving');
    saveNotes.mutate(
      { notes: value.trim() || null },
      {
        onSuccess: () => {
          savedNotes.current = value;
          setNoteState('saved');
        },
        onError: () => setNoteState('error'),
      },
    );
  };
  useEffect(() => {
    if (notes === savedNotes.current) return;
    pendingNotes.current = notes;
    const id = window.setTimeout(() => flushNotes(notes), 800);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);
  useEffect(() => () => {
    const v = pendingNotes.current;
    if (v !== null && v !== savedNotes.current) {
      void api(`/appointments/${appt.id}`, { method: 'PATCH', body: { notes: v.trim() || null } }).then(refresh, () => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const waLink = (url: string) =>
    cur.customerPhone
      ? `https://wa.me/${cur.customerPhone.replace(/\D/g, '')}?text=${encodeURIComponent(url)}`
      : undefined;

  // Pieces that can be changed right where they're shown
  const canReschedule = open && !cur.classSessionId;
  const canReassign = open && !scoped && !cur.classSessionId && atLoc.length > 0;
  const canParty = open && !scoped && withParty;
  const canPay = status !== 'cancelled' && (outstanding > 0 || (withParty && cur.priceCents === 0 && status !== 'no_show'));
  const editable = 'group inline-flex items-center gap-1 rounded px-1 -mx-1 text-left hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500';
  const pencil = <span aria-hidden className="text-xs text-slate-400 opacity-60 group-hover:opacity-100">✎</span>;

  return (
    <Modal open title={t(`kinds.${kind}.booking`)} onClose={onClose}>
      <div className="space-y-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-lg font-semibold leading-tight">{cur.customerName}</div>
            {cur.customerPhone && (
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-sm">
                <a href={`tel:${cur.customerPhone}`} className="text-slate-600 hover:text-brand-700">{cur.customerPhone}</a>
                <a href={`https://wa.me/${cur.customerPhone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer" className="font-medium text-emerald-700 hover:underline">WhatsApp</a>
              </div>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            {/* Status changes from its own chip (a "No asistió" by mistake goes back to "Confirmada"). */}
            <MenuButton
              ariaLabel={t('agenda.changeStatus')}
              testId="status-menu"
              label={<StatusBadge status={status} />}
              value={status}
              disabled={update.isPending}
              onChange={(st) => update.mutate({ status: st })}
              options={(['scheduled', 'confirmed', 'completed', 'no_show', 'cancelled'] as const).map((st) => ({
                value: st,
                label: <><span aria-hidden className="w-4 text-center">{BOOKING_ICON[st]}</span>{t(`status.${st}`)}</>,
              }))}
            />
            <PaymentBadge appt={{ priceCents: cur.priceCents, paidCents: cur.paidCents, status, endsAt: cur.endsAt }} noShowOwes={noShowOwes(tenant!.settings)} />
            <MethodTags methods={cur.paidMethods ?? []} />
          </div>
        </div>
        <div className="pt-1 text-slate-600">{cur.serviceName}</div>

        {editing === 'time' ? (
          <div className="flex flex-wrap items-center gap-2 py-1">
            <input type="datetime-local" className="input !w-auto !py-1.5" value={when} onChange={(e) => setWhen(e.target.value)} autoFocus aria-label={t('agenda.startsAt')} />
            <button className="btn-primary !py-1.5" disabled={update.isPending} onClick={() => update.mutate({ startsAt: new Date(when).toISOString() })}>{t('common.save')}</button>
            <button className="btn-secondary !py-1.5" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
          </div>
        ) : canReschedule ? (
          <button type="button" className={`${editable} text-sm text-slate-500`} onClick={() => setEditing('time')} aria-label={t('agenda.reschedule')} data-testid="edit-time">
            {dateTime(cur.startsAt)} – {timeOnly(cur.endsAt)} {pencil}
            <span className="text-slate-400">· {t(`source.${cur.source}`)}</span>
          </button>
        ) : (
          <div className="text-sm text-slate-500">{dateTime(cur.startsAt)} – {timeOnly(cur.endsAt)} · {t(`source.${cur.source}`)}</div>
        )}

        {(cur.resourceName || withParty || canReassign) && (
          <div className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-slate-700">
            {withParty && (editing === 'party' ? (
              <span className="flex items-center gap-2">
                <input type="number" min={1} max={50} className="input w-20 !py-1" value={party} onChange={(e) => setParty(e.target.value)} autoFocus aria-label={t('agenda.partySize')} />
                <button className="btn-primary !py-1" disabled={update.isPending} onClick={() => update.mutate({ partySize: Number(party) })}>{t('common.save')}</button>
                <button className="btn-secondary !py-1" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
              </span>
            ) : canParty ? (
              <button type="button" className={editable} onClick={() => setEditing('party')}>{t('agenda.attendees', { count: cur.partySize ?? 0 })} {pencil}</button>
            ) : (
              <span>{t('agenda.attendees', { count: cur.partySize ?? 0 })}</span>
            ))}
            {withParty && (cur.resourceName || canReassign) && <span className="text-slate-300">·</span>}
            {editing === 'resource' ? (
              <select
                className="input !w-auto !py-1"
                autoFocus
                aria-label={t(`kinds.${kind}.resource`)}
                defaultValue={cur.resourceId ?? ''}
                disabled={update.isPending}
                onChange={(e) => update.mutate({ resourceId: e.target.value || null })}
                onBlur={() => !update.isPending && setEditing(null)}
              >
                <option value="">{t('resources.auto')}</option>
                {eligible(cur.partySize).map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
              </select>
            ) : canReassign ? (
              <button type="button" className={editable} onClick={() => setEditing('resource')} data-testid="edit-resource" aria-label={t('agenda.changeResource', { what: t(`kinds.${kind}.resource`) })}>
                {cur.resourceColor && <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: cur.resourceColor }} />}
                {cur.resourceName ?? t('agenda.unassigned')} {pencil}
              </button>
            ) : cur.resourceName ? (
              <span className="inline-flex items-center gap-1">
                {cur.resourceColor && <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: cur.resourceColor }} />}
                {cur.resourceName}
              </span>
            ) : null}
          </div>
        )}
        {apptLocs.anyMulti && <div className="text-sm text-slate-500">⌂ {apptLocs.byId.get(cur.locationId)?.name}</div>}

        <div className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div><div className="text-slate-500">{t('agenda.price')}</div><div className="font-semibold">{money(cur.priceCents)}</div></div>
            <div><div className="text-slate-500">{t('agenda.paid')}</div><div className="font-semibold text-emerald-700">{money(cur.paidCents)}</div></div>
            <div><div className="text-slate-500">{t('agenda.outstanding')}</div><div className="font-semibold text-amber-700">{money(outstanding)}</div></div>
          </div>
          {cur.discountCents > 0 && cur.discountReason !== 'package' && (
            <p className="mt-2 text-center text-xs text-emerald-800" data-testid="appt-discount">
              {cur.discountReason === 'reward' ? `🎁 ${t('promos.rewardApplied')}` : `🏷️ ${t('promos.couponApplied')}${cur.couponCode ? ` ${cur.couponCode}` : ''}`}: −{money(cur.discountCents)}
            </p>
          )}
          {packagesOn && status === 'completed' && <PlanUse appt={cur} onChanged={async () => { refresh(); await reload(); }} />}
          {editing === 'pay' ? (
            <form
              className="mt-3 flex flex-wrap items-center justify-center gap-2 border-t border-slate-200 pt-3"
              onSubmit={(e) => {
                e.preventDefault();
                recordPay.mutate();
              }}
            >
              <input
                type="number"
                min={0.01}
                step="0.01"
                required
                className="input w-28 !py-1.5"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                autoFocus
                aria-label={withParty && cur.priceCents === 0 ? t('agenda.bill') : t('customers.amount')}
                placeholder={withParty && cur.priceCents === 0 ? t('agenda.bill') : ''}
              />
              <select id="am-method" className="input !w-auto !py-1.5" value={method} onChange={(e) => setMethod(e.target.value as typeof method)} aria-label={t('agenda.paymentMethod')}>
                {offline.map((m) => <option key={m} value={m}>{t(`methods.${m}`)}</option>)}
                {packagesOn && <option value="gift_card">{t('methods.gift_card')}</option>}
              </select>
              {method === 'gift_card' && (
                <input id="am-gift" required minLength={4} className="input w-32 !py-1.5 font-mono uppercase" placeholder={t('sales.giftCode')} value={giftCode} onChange={(e) => setGiftCode(e.target.value)} />
              )}
              <button className="btn-primary !py-1.5" disabled={recordPay.isPending}>{t('agenda.recordPayment')}</button>
              <button type="button" className="btn-secondary !py-1.5" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
              <ErrorText error={recordPay.error} ns="agenda" />
            </form>
          ) : editing === 'deposit' && deposit ? (
            <div className="mt-3 border-t border-slate-200 pt-3">
              {link?.checkoutUrl ? (
                <div className="space-y-2">
                  <p>{t('agenda.linkReady')}</p>
                  <input readOnly className="input" value={link.checkoutUrl} onFocus={(e) => e.target.select()} />
                  {waLink(link.checkoutUrl) && (
                    <a className="btn-primary" href={waLink(link.checkoutUrl)} target="_blank" rel="noreferrer">{t('agenda.sendWhatsapp')}</a>
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap items-end justify-center gap-2">
                  <div>
                    <label className="label">{t('agenda.depositAmount')}</label>
                    <input type="number" min={1} step="0.01" className="input w-32" value={deposit.amount} onChange={(e) => setDeposit({ ...deposit, amount: e.target.value })} />
                  </div>
                  <select className="input w-auto" value={deposit.method} onChange={(e) => setDeposit({ ...deposit, method: e.target.value as 'mercadopago' | 'spei' })} aria-label={t('agenda.paymentMethod')}>
                    {online.map((m) => <option key={m} value={m}>{t(`methods.${m}`)}</option>)}
                  </select>
                  <button className="btn-primary" disabled={createLink.isPending} onClick={() => createLink.mutate()}>{t('agenda.createLink')}</button>
                  <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
                </div>
              )}
              <ErrorText error={createLink.error} ns="agenda" />
            </div>
          ) : (canPay || (open && online.length > 0 && outstanding > 0)) && (
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2 border-t border-slate-200 pt-3">
              {canPay && <button type="button" className="btn-primary !py-1.5" onClick={startPay}>{t('agenda.charge')}</button>}
              {open && online.length > 0 && outstanding > 0 && (
                <button
                  type="button"
                  className="btn-secondary !py-1.5"
                  onClick={() => {
                    setDeposit({ amount: String((computeDepositCents(outstanding, pay) || Math.round(outstanding / 2)) / 100 || ''), method: online[0]! });
                    setLink(null);
                    setEditing('deposit');
                  }}
                >
                  {t('agenda.requestDeposit')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <ErrorText error={update.error} ns="agenda" />

      {!cur.classSessionId && (
        <div className="mt-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label className="label !mb-0" htmlFor="am-notes">{t('agenda.notes')}</label>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">{t('rating.visit')}</span>
              <StarRating
                value={rating}
                onChange={(v) => {
                  setRating(v);
                  saveNotes.mutate({ rating: v });
                }}
              />
            </div>
          </div>
          <textarea
            id="am-notes"
            rows={2}
            maxLength={2000}
            className="input"
            placeholder={t('agenda.notesPlaceholder')}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => flushNotes()}
          />
          <p className="h-4 text-right text-xs" aria-live="polite">
            {noteState === 'saving' && <span className="text-slate-500">{t('common.saving')}</span>}
            {noteState === 'saved' && <span className="text-emerald-700">✓ {t('common.saved')}</span>}
            {noteState === 'error' && <span className="text-rose-700">{t('agenda.notesError')}</span>}
          </p>
        </div>
      )}

      <div className="mt-4"><AppointmentForms appointmentId={cur.id} /></div>

      {status === 'completed' && cur.customerPhone && (
        <a
          className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-emerald-700 hover:underline"
          data-testid="ask-review"
          target="_blank"
          rel="noreferrer"
          href={`https://wa.me/${cur.customerPhone.replace(/\D/g, '')}?text=${encodeURIComponent(t('reviews.askMessage', { name: cur.customerName.split(' ')[0], business: tenant!.name, url: `${window.location.origin}${cur.managePath.replace('/c/', '/r/')}` }))}`}
        >
          ⭐ {t('reviews.askWhatsapp')}
        </a>
      )}

      {open && (selfService.rescheduleEnabled || selfService.cancelEnabled) && (
        <div className="mt-2 rounded-lg border border-slate-200 p-3 text-sm">
          <label className="label">{t('agenda.manageLink')}</label>
          <p className="mb-2 text-xs text-slate-500">{t('agenda.manageLinkHelp', { hours: selfService.minHoursNotice })}</p>
          <div className="flex flex-wrap gap-2">
            <input readOnly className="input min-w-0 flex-1" value={manageUrl} onFocus={(e) => e.target.select()} />
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(manageUrl);
                setCopied(true);
              }}
            >
              {copied ? t('common.copied') : t('common.copy')}
            </button>
            {waLink(manageMsg) && (
              <a className="btn-secondary" href={waLink(manageMsg)} target="_blank" rel="noreferrer">WhatsApp</a>
            )}
          </div>
        </div>
      )}

      <div className="mt-6 flex justify-between">
        {manager ? (
          <button
            className="text-sm text-rose-700 hover:underline"
            onClick={() => window.confirm(t('agenda.deleteConfirm')) && remove.mutate()}
          >
            {t('common.delete')}
          </button>
        ) : <span />}
        <button className="btn-secondary" onClick={onClose}>{t('common.close')}</button>
      </div>
    </Modal>
  );
}

/**
 * Block time so nobody can book it: the whole business, one location or one person/space
 * (vacation, holiday, a court under repair). Whole days or a stretch of hours.
 */
function BlockModal({
  block,
  initialDay,
  resources,
  presetResource,
  onClose,
}: {
  block: TimeBlockDto | null;
  initialDay: Date;
  resources: ResourceDto[];
  presetResource: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { tenant } = useAuth();
  const kind = tenant?.kind ?? 'appointments';
  const { manager, scoped, resourceId: ownResource, locationId: ownLocation } = useAccess();
  const locs = useMyLocations(ownLocation);
  const qc = useQueryClient();
  const ymd = (d: Date) => format(d, 'yyyy-MM-dd');
  const hm = (d: Date) => format(d, 'HH:mm');
  const s0 = block ? new Date(block.startsAt) : startOfDay(initialDay);
  const e0 = block ? new Date(block.endsAt) : addDays(startOfDay(initialDay), 1);
  const allDay0 = hm(s0) === '00:00' && hm(e0) === '00:00';
  const [f, setF] = useState({
    target: block?.resourceId ? `r:${block.resourceId}` : block?.locationId ? `l:${block.locationId}` : scoped && ownResource ? `r:${ownResource}` : presetResource ? `r:${presetResource}` : ownLocation ? `l:${ownLocation}` : '',
    allDay: allDay0,
    fromDay: ymd(s0),
    toDay: ymd(allDay0 ? addDays(e0, -1) : e0),
    fromTime: allDay0 ? '14:00' : hm(s0),
    toTime: allDay0 ? '16:00' : hm(e0),
    reason: block?.reason ?? '',
  });
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const at = (day: string, time: string) => {
    const [y, m, d] = day.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    return new Date(y!, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
  };
  const range = () =>
    f.allDay
      ? { startsAt: at(f.fromDay, '00:00'), endsAt: addDays(at(f.toDay < f.fromDay ? f.fromDay : f.toDay, '00:00'), 1) }
      : { startsAt: at(f.fromDay, f.fromTime), endsAt: at(f.fromDay, f.toTime) };
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['time-blocks'] });
    onClose();
  };
  const save = useMutation({
    mutationFn: async () => {
      const r = range();
      const [kindOf, id] = f.target ? (f.target.split(':') as ['r' | 'l', string]) : [null, null];
      // Editing = replace (blocks are small and rarely edited).
      if (block) await api(`/time-blocks/${block.id}`, { method: 'DELETE' });
      return api<TimeBlockDto>('/time-blocks', {
        method: 'POST',
        body: {
          startsAt: r.startsAt.toISOString(),
          endsAt: r.endsAt.toISOString(),
          resourceId: kindOf === 'r' ? id : null,
          locationId: kindOf === 'l' ? id : null,
          reason: f.reason.trim() || null,
        },
      });
    },
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api(`/time-blocks/${block!.id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const invalid = !f.allDay && f.toTime <= f.fromTime;

  return (
    <Modal open title={block ? t('blocks.edit') : t('blocks.add')} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!invalid) save.mutate(); }}>
        <p className="text-sm text-slate-500">{t('blocks.help')}</p>
        <div>
          <label className="label" htmlFor="bl-target">{t('blocks.who')}</label>
          <select id="bl-target" className="input" value={f.target} disabled={scoped} onChange={(e) => set({ target: e.target.value })}>
            {manager && !ownLocation && <option value="">{t('blocks.wholeBusiness')}</option>}
            {manager && locs.multi && locs.list.map((l) => <option key={l.id} value={`l:${l.id}`}>⌂ {l.name}</option>)}
            {manager && ownLocation && !locs.multi && locs.list[0] && <option value={`l:${locs.list[0].id}`}>⌂ {locs.list[0].name}</option>}
            {(scoped ? resources.filter((r) => r.id === ownResource) : resources).map((r) => (
              <option key={r.id} value={`r:${r.id}`}>{t(`kinds.${kind}.resource`)}: {r.name}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.allDay} onChange={(e) => set({ allDay: e.target.checked })} />
          {t('blocks.allDay')}
        </label>
        {f.allDay ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="bl-from">{t('blocks.fromDay')}</label>
              <input id="bl-from" type="date" required className="input" value={f.fromDay} onChange={(e) => set({ fromDay: e.target.value, toDay: e.target.value > f.toDay ? e.target.value : f.toDay })} />
            </div>
            <div>
              <label className="label" htmlFor="bl-to">{t('blocks.toDay')}</label>
              <input id="bl-to" type="date" required min={f.fromDay} className="input" value={f.toDay} onChange={(e) => set({ toDay: e.target.value })} />
            </div>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="bl-day">{t('blocks.day')}</label>
              <input id="bl-day" type="date" required className="input" value={f.fromDay} onChange={(e) => set({ fromDay: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="bl-ft">{t('blocks.from')}</label>
              <input id="bl-ft" type="time" required className="input" value={f.fromTime} onChange={(e) => set({ fromTime: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="bl-tt">{t('blocks.to')}</label>
              <input id="bl-tt" type="time" required className="input" value={f.toTime} onChange={(e) => set({ toTime: e.target.value })} />
            </div>
          </div>
        )}
        {invalid && <p className="text-xs text-rose-600">{t('blocks.endAfterStart')}</p>}
        <div>
          <label className="label" htmlFor="bl-reason">{t('blocks.reason')}</label>
          <input id="bl-reason" maxLength={200} className="input" placeholder={t('blocks.reasonPlaceholder')} value={f.reason} onChange={(e) => set({ reason: e.target.value })} />
        </div>
        <p className="rounded-lg bg-amber-50 p-2 text-xs text-amber-800">{t('blocks.existingNote')}</p>
        <ErrorText error={save.error ?? remove.error} ns="blocks" />
        <div className="flex items-center justify-between">
          {block ? (
            <button type="button" className="text-sm text-rose-700 hover:underline" onClick={() => remove.mutate()}>
              {t('blocks.unblock')}
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn-primary" disabled={save.isPending || invalid}>{t('common.save')}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

/** What the marks on the cards mean: booking state on the left, payment state on the right. */
function StatusLegend() {
  const { t } = useTranslation();
  const statuses = ['scheduled', 'confirmed', 'completed', 'no_show', 'cancelled'] as const;
  const pays = ['paid', 'partial', 'unpaid', 'owed'] as const;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
      {statuses.map((st) => (
        <span key={st} className="inline-flex items-center gap-1">
          <span className="w-3 text-center font-semibold" aria-hidden>{BOOKING_ICON[st]}</span>
          {t(`status.${st}`)}
        </span>
      ))}
      <span className="hidden h-4 w-px bg-slate-300 sm:inline-block" aria-hidden />
      {pays.map((p) => (
        <span key={p} className="inline-flex items-center gap-1">
          <span className={`rounded px-1 text-[10px] font-bold leading-4 ${PAYMENT_PILL[p]}`} aria-hidden>{PAYMENT_PILL_TEXT[p]}</span>
          {t(`payState.${p}`)}
        </span>
      ))}
    </div>
  );
}

