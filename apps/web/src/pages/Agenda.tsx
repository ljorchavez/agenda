import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, format, isSameDay, startOfDay, startOfWeek } from 'date-fns';
import {
  bookingPriceCents,
  computeDepositCents,
  eligibleResources,
  intervalsOnWeekday,
  kindConfig,
  paymentSettingsOf,
  rentalSettingsOf,
  selfServiceOf,
  type AppointmentDto,
  type BusinessHours,
  type ClassSessionDto,
  type CustomerDto,
  type PaymentDto,
  type ResourceDto,
  type TimeBlockDto,
} from '@agenda/shared';
import { useAccess, useAuth } from '../lib/auth';
import { ErrorText, Loading, Modal, PageHeader, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { dateLocale, dateTime, money, timeOnly, toCents, toLocalInput } from '../lib/format';
import { useCustomers, useMyLocations, useResources, useServices } from '../lib/queries';
import { LocationSelect } from '../components/Locations';
import { CalendarGrid, type CalBlock, type CalColumn, type CalEvent } from '../components/CalendarGrid';
import type { HoursValue } from '../components/Schedule';
import { StarRating } from '../components/Rating';
import { NewSessionModal, SessionModal } from '../components/ClassModals';

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
const STATUS_ICON: Record<AppointmentDto['status'], string> = {
  scheduled: '',
  confirmed: '✓',
  completed: '✔',
  cancelled: '⊘',
  no_show: '✕',
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
            icon: STATUS_ICON[a.status],
            tone: a.status === 'cancelled' ? 'cancelled' : a.status === 'no_show' ? 'alert' : a.status === 'completed' ? 'muted' : 'normal',
            label: [fmtRange(start, end), a.customerName, sub, a.resourceName, t(`status.${a.status}`)].filter(Boolean).join(' · '),
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
      {canCreate && <p className="mt-2 hidden text-xs text-slate-500 sm:block">{t('agenda.tapToCreate')}</p>}

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
  const [search, setSearch] = useState('');
  const customers = useCustomers(search, 'name', scoped);
  const [customerId, setCustomerId] = useState('');
  const [newCustomer, setNewCustomer] = useState<{ name: string; phone: string } | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [startsAt, setStartsAt] = useState(toLocalInput(initial));
  const [duration, setDuration] = useState(cfg.durations ? String(durations[0]) : '');
  const [price, setPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [allowOverlap, setAllowOverlap] = useState(false);

  const active = (services.data ?? []).filter((s) => s.active);
  const svc = active.find((s) => s.id === serviceId);
  const atLoc = (resourcesQ.data ?? []).filter((r) => r.active && (!effectiveLoc || r.locationId === effectiveLoc));
  const eligible = eligibleResources(atLoc, { serviceId: needsService ? serviceId || null : null, partySize: cfg.partySize ? Number(partySize || 1) : null });
  const resource = atLoc.find((r) => r.id === resourceId);
  const durationMin = Number(duration || svc?.durationMin || 0);
  const suggested = bookingPriceCents(resource, svc?.priceCents ?? 0, durationMin);

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
          startsAt: new Date(startsAt).toISOString(),
          durationMin: duration ? Number(duration) : undefined,
          priceCents: price !== '' ? toCents(price) : undefined,
          notes: notes || null,
          allowOverlap,
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

  return (
    <Modal open title={t(`kinds.${kind}.newBooking`)} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        {!scoped && locs.multi && (
          <div>
            <label className="label" htmlFor="na-loc">{t('locations.location')}</label>
            <LocationSelect
              id="na-loc"
              value={effectiveLoc}
              onChange={(v) => { setLocationId(v); setResourceId(''); }}
              list={locs.list}
            />
          </div>
        )}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="label mb-0">{t('agenda.customer')}</label>
            <button
              type="button"
              className="text-sm font-medium text-brand-700"
              onClick={() => setNewCustomer(newCustomer ? null : { name: '', phone: '' })}
            >
              {newCustomer ? t('common.cancel') : t('agenda.newCustomer')}
            </button>
          </div>
          {newCustomer ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <input required placeholder={t('customers.name')} className="input" value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} />
              <input type="tel" placeholder={t('customers.phone')} className="input" value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} />
            </div>
          ) : (
            <>
              <input placeholder={t('customers.searchPlaceholder')} className="input mb-2" value={search} onChange={(e) => setSearch(e.target.value)} />
              <select required className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)} size={Math.min(5, Math.max(2, customers.data?.items.length ?? 2))}>
                {(customers.data?.items ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}{c.phone ? ` · ${c.phone}` : ''}</option>
                ))}
              </select>
            </>
          )}
        </div>
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
        <div className="grid gap-4 sm:grid-cols-2">
          {cfg.partySize && (
            <div>
              <label className="label" htmlFor="na-party">{t('agenda.partySize')}</label>
              <input id="na-party" type="number" min={1} max={50} required className="input" value={partySize} onChange={(e) => setPartySize(e.target.value)} />
            </div>
          )}
          {scoped ? (
            <p className="text-sm text-slate-500 sm:col-span-2">{t('roles.bookingFor', { name: atLoc.find((r) => r.id === ownResource)?.name ?? user?.name })}</p>
          ) : atLoc.length > 0 && (
            <div>
              <label className="label" htmlFor="na-res">{t(`kinds.${kind}.resource`)}</label>
              <select id="na-res" className="input" value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
                <option value="">{t('resources.auto')}</option>
                {eligible.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
              </select>
            </div>
          )}
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <label className="label" htmlFor="na-start">{t('agenda.startsAt')}</label>
            <input id="na-start" type="datetime-local" required className="input" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
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
          <div>
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
        </div>
        <div>
          <label className="label" htmlFor="na-notes">{t('agenda.notes')}</label>
          <textarea id="na-notes" className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {!scoped && (
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={allowOverlap} onChange={(e) => setAllowOverlap(e.target.checked)} />
            {t('agenda.allowOverlap')}
          </label>
        )}
        <ErrorText error={create.error} ns="agenda" />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={create.isPending}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>
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
  const [method, setMethod] = useState<'cash' | 'card' | 'transfer'>(offline[0]!);
  const [reschedule, setReschedule] = useState(toLocalInput(new Date(appt.startsAt)));
  const [deposit, setDeposit] = useState<{ amount: string; method: 'mercadopago' | 'spei' } | null>(null);
  const [link, setLink] = useState<PaymentDto | null>(null);
  const outstanding = Math.max(appt.priceCents - appt.paidCents, 0);
  const selfService = selfServiceOf(tenant!.settings);
  const [copied, setCopied] = useState(false);
  const kind = tenant?.kind ?? 'appointments';
  const cfg = kindConfig(kind);
  const label = useResourceLabel();
  const resourcesQ = useResources();
  const atLoc = (resourcesQ.data ?? []).filter((r) => r.active && r.locationId === appt.locationId);
  // Party size kinds (restaurants) charge the bill when the visit ends.
  const withParty = cfg.partySize && appt.partySize != null && !appt.classSessionId;
  const [party, setParty] = useState(String(appt.partySize ?? 2));
  const [res, setRes] = useState(appt.resourceId ?? '');
  const eligible = eligibleResources(atLoc, { serviceId: appt.serviceId, partySize: withParty ? Number(party || 1) : null });
  const [bill, setBill] = useState('');
  const manageUrl = `${window.location.origin}${appt.managePath}`;
  const manageMsg = t('agenda.manageMessage', {
    name: appt.customerName.split(' ')[0],
    business: tenant!.name,
    date: dateTime(appt.startsAt),
    url: manageUrl,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['appointments'] });
    void qc.invalidateQueries({ queryKey: ['customers'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
    void qc.invalidateQueries({ queryKey: ['payments'] });
  };

  const update = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<AppointmentDto>(`/appointments/${appt.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api(`/appointments/${appt.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const createLink = useMutation({
    mutationFn: () =>
      api<PaymentDto>('/payments/link', {
        method: 'POST',
        body: { appointmentId: appt.id, amountCents: toCents(deposit!.amount), method: deposit!.method },
      }),
    onSuccess: (p) => {
      setLink(p);
      refresh();
    },
  });

  // Notes and rating save in place (the modal stays open).
  const [notes, setNotes] = useState(appt.notes ?? '');
  const [rating, setRating] = useState<number | null>(appt.rating);
  const [savedNote, setSavedNote] = useState(false);
  const saveNotes = useMutation({
    mutationFn: (body: { notes?: string | null; rating?: number | null }) =>
      api<AppointmentDto>(`/appointments/${appt.id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setSavedNote(true);
      refresh();
    },
  });

  const open = appt.status === 'scheduled' || appt.status === 'confirmed';
  const waLink = (url: string) =>
    appt.customerPhone
      ? `https://wa.me/${appt.customerPhone.replace(/\D/g, '')}?text=${encodeURIComponent(url)}`
      : undefined;

  return (
    <Modal open title={t(`kinds.${kind}.booking`)} onClose={onClose}>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">{appt.customerName}</div>
          <StatusBadge status={appt.status} />
        </div>
        <div className="text-slate-600">{appt.serviceName}</div>
        <div className="text-sm text-slate-500">{dateTime(appt.startsAt)} – {timeOnly(appt.endsAt)} · {t(`source.${appt.source}`)}</div>
        {(appt.resourceName || withParty) && (
          <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
            {appt.resourceColor && <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: appt.resourceColor }} />}
            {[withParty && t('agenda.attendees', { count: appt.partySize ?? 0 }), appt.resourceName ?? (atLoc.length ? t('agenda.unassigned') : '')].filter(Boolean).join(' · ')}
          </div>
        )}
        {apptLocs.anyMulti && <div className="text-sm text-slate-500">⌂ {apptLocs.byId.get(appt.locationId)?.name}</div>}
        {appt.customerPhone && <div className="text-sm text-slate-500">{appt.customerPhone}</div>}
        <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center text-sm">
          <div><div className="text-slate-500">{t('agenda.price')}</div><div className="font-semibold">{money(appt.priceCents)}</div></div>
          <div><div className="text-slate-500">{t('agenda.paid')}</div><div className="font-semibold text-emerald-700">{money(appt.paidCents)}</div></div>
          <div><div className="text-slate-500">{t('agenda.outstanding')}</div><div className="font-semibold text-amber-700">{money(outstanding)}</div></div>
        </div>
      </div>

      {!appt.classSessionId && (
        <div className="mt-4 space-y-2 rounded-lg border border-slate-200 p-3">
          <div className="flex items-center justify-between gap-2">
            <label className="label !mb-0" htmlFor="am-notes">{t('agenda.notes')}</label>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500">{t('rating.visit')}</span>
              <StarRating
                value={rating}
                onChange={(v) => {
                  setRating(v);
                  setSavedNote(false);
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
            onChange={(e) => {
              setNotes(e.target.value);
              setSavedNote(false);
            }}
          />
          <div className="flex items-center justify-end gap-3">
            {savedNote && !saveNotes.isPending && <span className="text-xs text-emerald-700">✓ {t('common.saved')}</span>}
            <button
              type="button"
              className="btn-secondary !py-1.5 text-sm"
              disabled={saveNotes.isPending || notes === (appt.notes ?? '')}
              onClick={() => saveNotes.mutate({ notes: notes.trim() || null })}
            >
              {t('agenda.saveNotes')}
            </button>
          </div>
          <ErrorText error={saveNotes.error} ns="agenda" />
        </div>
      )}

      {open && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap gap-2">
            {appt.status === 'scheduled' && (
              <button className="btn-secondary" onClick={() => update.mutate({ status: 'confirmed' })}>{t('agenda.confirm')}</button>
            )}
            <button className="btn-secondary" onClick={() => update.mutate({ status: 'no_show' })}>{t('agenda.noShow')}</button>
            <button className="btn-secondary text-rose-700" onClick={() => update.mutate({ status: 'cancelled' })}>{t('agenda.cancelAppt')}</button>
          </div>

          {!scoped && !appt.classSessionId && (atLoc.length > 0 || withParty) && (
            <div className="rounded-lg border border-slate-200 p-3">
              <label className="label" htmlFor="am-res">{t(`kinds.${kind}.resource`)}</label>
              <div className="flex flex-wrap gap-2">
                {withParty && (
                  <input type="number" min={1} max={50} className="input w-24" value={party} onChange={(e) => setParty(e.target.value)} aria-label={t('agenda.partySize')} />
                )}
                {atLoc.length > 0 && (
                  <select id="am-res" className="input w-auto" value={res} onChange={(e) => setRes(e.target.value)}>
                    <option value="">{t('resources.auto')}</option>
                    {eligible.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
                  </select>
                )}
                <button
                  className="btn-secondary"
                  onClick={() => update.mutate({ ...(atLoc.length ? { resourceId: res || null } : {}), ...(withParty ? { partySize: Number(party) } : {}) })}
                >
                  {t('common.save')}
                </button>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-slate-200 p-3">
            <label className="label">{t('agenda.paymentMethod')}</label>
            <div className="flex flex-wrap gap-2">
              <select className="input w-auto" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                {offline.map((m) => (
                  <option key={m} value={m}>{t(`methods.${m}`)}</option>
                ))}
              </select>
              {withParty && (
                <input type="number" min={0} step="0.01" className="input w-32" placeholder={t('agenda.bill')} value={bill} onChange={(e) => setBill(e.target.value)} aria-label={t('agenda.bill')} />
              )}
              <button className="btn-primary" onClick={() => update.mutate({ status: 'completed', paymentMethod: method, ...(withParty && bill !== '' ? { priceCents: toCents(bill) } : {}) })}>
                {t('agenda.complete')}
              </button>
            </div>
          </div>

          {!appt.classSessionId && <div className="rounded-lg border border-slate-200 p-3">
            <label className="label">{t('agenda.startsAt')}</label>
            <div className="flex flex-wrap gap-2">
              <input type="datetime-local" className="input w-auto" value={reschedule} onChange={(e) => setReschedule(e.target.value)} />
              <button className="btn-secondary" onClick={() => update.mutate({ startsAt: new Date(reschedule).toISOString() })}>
                {t('common.save')}
              </button>
            </div>
          </div>}

          {(selfService.rescheduleEnabled || selfService.cancelEnabled) && (
            <div className="rounded-lg border border-slate-200 p-3 text-sm">
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

          {online.length > 0 && <div className="rounded-lg border border-slate-200 p-3">
            {!deposit ? (
              <button className="text-sm font-medium text-brand-700" onClick={() => setDeposit({ amount: String((computeDepositCents(outstanding, pay) || Math.round(outstanding / 2)) / 100 || ''), method: online[0]! })}>
                {t('agenda.requestDeposit')} →
              </button>
            ) : link?.checkoutUrl ? (
              <div className="space-y-2 text-sm">
                <p>{t('agenda.linkReady')}</p>
                <input readOnly className="input" value={link.checkoutUrl} onFocus={(e) => e.target.select()} />
                {waLink(link.checkoutUrl) && (
                  <a className="btn-primary" href={waLink(link.checkoutUrl)} target="_blank" rel="noreferrer">{t('agenda.sendWhatsapp')}</a>
                )}
              </div>
            ) : (
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="label">{t('agenda.depositAmount')}</label>
                  <input type="number" min={1} step="0.01" className="input w-32" value={deposit.amount} onChange={(e) => setDeposit({ ...deposit, amount: e.target.value })} />
                </div>
                <select className="input w-auto" value={deposit.method} onChange={(e) => setDeposit({ ...deposit, method: e.target.value as 'mercadopago' | 'spei' })}>
                  {online.map((m) => (
                    <option key={m} value={m}>{t(`methods.${m}`)}</option>
                  ))}
                </select>
                <button className="btn-primary" disabled={createLink.isPending} onClick={() => createLink.mutate()}>{t('agenda.createLink')}</button>
              </div>
            )}
            <ErrorText error={createLink.error} ns="agenda" />
          </div>}
        </div>
      )}

      <ErrorText error={update.error} ns="agenda" />
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
