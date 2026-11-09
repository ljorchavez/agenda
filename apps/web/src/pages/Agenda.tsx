import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addDays, format, isSameDay, startOfDay, startOfWeek } from 'date-fns';
import { computeDepositCents, eligibleProfessionals, paymentSettingsOf, rentalSettingsOf, selfServiceOf, spacePriceCents, type AppointmentDto, type BusinessHours, type CustomerDto, type PaymentDto, type TableDto } from '@agenda/shared';
import { useAccess, useAuth } from '../lib/auth';
import { ErrorText, Loading, Modal, PageHeader, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { dateLocale, dateTime, money, timeOnly, toCents, toLocalInput } from '../lib/format';
import { useCustomers, useMyLocations, useProfessionals, useServices, useSpaces } from '../lib/queries';
import { LocationSelect } from '../components/Locations';
import { CalendarGrid, type CalColumn, type CalEvent } from '../components/CalendarGrid';

const useTables = (enabled: boolean) =>
  useQuery({ queryKey: ['tables'], queryFn: () => api<TableDto[]>('/tables'), enabled });

type View = 'day' | 'week' | 'team';
const VIEW_KEY = 'agenda.view';
const savedView = (): View | null => {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'day' || v === 'week' || v === 'team' ? v : null;
  } catch {
    return null;
  }
};
const isSmallScreen = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches;
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

export function AgendaPage() {
  const { t, i18n } = useTranslation();
  const { tenant } = useAuth();
  const { scoped, unlinked, locationId: ownLocation } = useAccess();
  const locs = useMyLocations(ownLocation);
  const [loc, setLoc] = useState('');
  const isRestaurant = tenant?.kind === 'reservations';
  const isRentals = tenant?.kind === 'rentals';
  const isClasses = tenant?.kind === 'classes';
  const pros = useProfessionals(tenant?.kind === 'appointments');
  const spaces = useSpaces(isRentals);
  const tables = useTables(isRestaurant && !scoped);
  const inLoc = (x: { locationId: string }) => !loc || x.locationId === loc;
  // Filter chips: one per professional (team) or space (rentals) of the selected location
  const resources = isRentals
    ? (spaces.data ?? []).filter((x) => x.active && inLoc(x)).map((x) => ({ id: x.id, name: x.name, color: '#475569' }))
    : (pros.data ?? []).filter((x) => x.active && inLoc(x)).map((x) => ({ id: x.id, name: x.name, color: x.color }));
  const [filter, setFilter] = useState('');
  // Columns of the "team" view: people, spaces or tables
  const teamResources = (
    isRestaurant
      ? (tables.data ?? [])
          .filter((x) => x.active && inLoc(x))
          .map((x) => ({ id: x.id, name: x.name, color: BRAND, locationId: x.locationId, sub: t('tables.people', { count: x.seats }) as string }))
      : isRentals
        ? (spaces.data ?? []).filter((x) => x.active && inLoc(x)).map((x) => ({ id: x.id, name: x.name, color: '#475569', locationId: x.locationId, sub: '' }))
        : (pros.data ?? []).filter((x) => x.active && inLoc(x)).map((x) => ({ id: x.id, name: x.name, color: x.color, locationId: x.locationId, sub: '' }))
  ).filter((r) => !filter || r.id === filter);
  const teamAvailable = !scoped && !isClasses && (isRestaurant ? (tables.data ?? []).length > 1 : resources.length > 1);

  // Businesses with several people/tables/spaces read best one column per resource (like Teams' schedule view).
  const [viewPref, setViewPref] = useState<View | null>(() => savedView());
  const preferred: View = viewPref ?? (teamAvailable ? 'team' : isSmallScreen() ? 'day' : 'week');
  const view: View = preferred === 'team' && !teamAvailable ? 'day' : preferred;
  const setView = (v: View) => {
    setViewPref(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode */
    }
  };
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [showCancelled, setShowCancelled] = useState(false);
  const [creating, setCreating] = useState<{ at: Date; locationId?: string; preset?: Preset } | null>(null);
  const [selected, setSelected] = useState<AppointmentDto | null>(null);
  const [classGroup, setClassGroup] = useState<AppointmentDto[] | null>(null);
  const weekStart = startOfWeek(anchor, { weekStartsOn: 1 });
  const weekDays = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const { data, isLoading } = useQuery({
    queryKey: ['appointments', weekStart.toISOString()],
    queryFn: () =>
      api<AppointmentDto[]>(
        `/appointments?from=${encodeURIComponent(weekStart.toISOString())}&to=${encodeURIComponent(addDays(weekStart, 7).toISOString())}`,
      ),
  });

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

  const appts = (data ?? []).filter(
    (a) => inLoc(a) && (!filter || a.professionalId === filter || a.spaceId === filter) && (showCancelled || a.status !== 'cancelled'),
  );
  const fmtTime = (d: Date) => format(d, i18n.language.startsWith('en') ? 'h:mm a' : 'HH:mm');
  const fmtRange = (s: Date, e: Date) => `${fmtTime(s)} – ${fmtTime(e)}`;

  const subtitleOf = (a: AppointmentDto) =>
    a.tableId || (isRestaurant && a.partySize)
      ? `${t('tables.people', { count: a.partySize ?? 0 })}${a.tableName ? ` · ${a.tableName}` : ''}`
      : a.spaceName ?? a.serviceName;
  const toEvent = (a: AppointmentDto, showPerson: boolean): CalEvent => {
    const start = new Date(a.startsAt);
    const end = new Date(a.endsAt);
    const sub = isRentals ? a.serviceName : subtitleOf(a);
    return {
      id: a.id,
      start,
      end,
      color: a.professionalColor ?? (isRentals ? '#475569' : BRAND),
      title: a.customerName,
      subtitle: sub,
      detail: showPerson ? a.professionalName ?? a.spaceName : null,
      icon: STATUS_ICON[a.status],
      tone: a.status === 'cancelled' ? 'cancelled' : a.status === 'no_show' ? 'alert' : a.status === 'completed' ? 'muted' : 'normal',
      label: [fmtRange(start, end), a.customerName, sub, a.professionalName ?? a.spaceName, t(`status.${a.status}`)].filter(Boolean).join(' · '),
      onClick: () => setSelected(a),
    };
  };
  /** Group class bookings into one block per class session. */
  const toEvents = (list: AppointmentDto[], showPerson: boolean): CalEvent[] => {
    const groups = new Map<string, AppointmentDto[]>();
    const out: CalEvent[] = [];
    for (const a of list) {
      if (a.classSessionId) groups.set(a.classSessionId, [...(groups.get(a.classSessionId) ?? []), a]);
      else out.push(toEvent(a, showPerson));
    }
    for (const [sid, g] of groups) {
      const a = g[0]!;
      const start = new Date(a.startsAt);
      const end = new Date(a.endsAt);
      const people = g.filter((x) => x.status !== 'cancelled').reduce((n, x) => n + (x.partySize ?? 1), 0);
      const attendees = t('agenda.attendees', { count: people });
      out.push({
        id: `class-${sid}`,
        start,
        end,
        color: a.professionalColor ?? BRAND,
        title: a.serviceName,
        subtitle: attendees,
        detail: a.professionalName,
        label: [fmtRange(start, end), a.serviceName, attendees, a.professionalName].filter(Boolean).join(' · '),
        onClick: () => setClassGroup(g),
      });
    }
    return out;
  };

  const onDay = (d: Date) => appts.filter((a) => isSameDay(new Date(a.startsAt), d));
  const dayHeader = (d: Date, clickable: boolean) => {
    const isToday = isSameDay(d, today);
    const count = toEvents(onDay(d), false).length;
    const inner = (
      <>
        <span className={`text-[11px] font-semibold uppercase tracking-wide ${isToday ? 'text-brand-700' : 'text-slate-500'}`}>
          {format(d, 'EEE', { locale: dateLocale() })}
        </span>
        <span className={`flex h-8 w-8 items-center justify-center rounded-full text-lg font-semibold ${isToday ? 'bg-brand-700 text-white' : 'text-slate-800'}`}>
          {format(d, 'd')}
        </span>
        <span className="text-[11px] text-slate-500">{count ? t('agenda.count', { count }) : ' '}</span>
      </>
    );
    return clickable ? (
      <button type="button" className="flex w-full flex-col items-center rounded-md hover:bg-slate-50" onClick={() => { setAnchor(startOfDay(d)); setView('day'); }} aria-label={format(d, 'PPPP', { locale: dateLocale() })}>
        {inner}
      </button>
    ) : (
      <div className="flex flex-col items-center">{inner}</div>
    );
  };
  const newAt = (at: Date, locationId?: string, preset?: Preset) => setCreating({ at, locationId: locationId ?? loc, preset });

  let columns: CalColumn[];
  if (view === 'team') {
    const day = onDay(anchor);
    const key = (a: AppointmentDto) => (isRestaurant ? a.tableId : isRentals ? a.spaceId : a.professionalId);
    columns = teamResources.map((r) => ({
      key: r.id,
      date: anchor,
      isToday: isSameDay(anchor, today),
      open: openFor(anchor, [r.locationId]),
      events: toEvents(day.filter((a) => key(a) === r.id), false),
      onCreate: (at: Date) =>
        newAt(at, r.locationId, isRestaurant ? { tableId: r.id } : isRentals ? { spaceId: r.id } : { professionalId: r.id }),
      header: (
        <div className="flex min-w-0 flex-col items-center px-1 text-center">
          <span className="flex max-w-full items-center gap-1.5 text-sm font-semibold text-slate-800">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color }} />
            <span className="truncate">{r.name}</span>
          </span>
          <span className="truncate text-[11px] text-slate-500">
            {[r.sub, locs.multi && !loc ? loc0(r.locationId)?.name : ''].filter(Boolean).join(' · ') || t('agenda.count', { count: toEvents(day.filter((a) => key(a) === r.id), false).length })}
          </span>
        </div>
      ),
    }));
    const unassigned = day.filter((a) => !key(a) || !teamResources.some((r) => r.id === key(a)));
    if (unassigned.length && !filter) {
      columns.push({
        key: 'unassigned',
        date: anchor,
        isToday: isSameDay(anchor, today),
        open: openFor(anchor, visibleLocIds),
        events: toEvents(unassigned, true),
        onCreate: (at) => newAt(at),
        header: (
          <div className="flex flex-col items-center text-center">
            <span className="text-sm font-semibold text-slate-600">{isRestaurant ? t('agenda.noTable') : t('agenda.unassigned')}</span>
            <span className="text-[11px] text-slate-500">{t('agenda.count', { count: unassigned.length })}</span>
          </div>
        ),
      });
    }
  } else {
    // Week view shows the days the business opens (plus any day that has bookings).
    const days =
      view === 'day'
        ? [anchor]
        : weekDays.filter((d) => openFor(d, visibleLocIds) || onDay(d).length > 0).length
          ? weekDays.filter((d) => openFor(d, visibleLocIds) || onDay(d).length > 0)
          : weekDays;
    const showPerson = !filter && resources.length > 1;
    columns = days.map((d) => ({
      key: d.toISOString(),
      date: d,
      isToday: isSameDay(d, today),
      open: openFor(d, visibleLocIds),
      events: toEvents(onDay(d), showPerson),
      onCreate: (at: Date) => newAt(at),
      onMore: () => {
        setAnchor(startOfDay(d));
        setView(teamAvailable ? 'team' : 'day');
      },
      header: dayHeader(d, view === 'week'),
    }));
  }

  // Visible hours: from the earliest opening to the latest closing, stretched to fit bookings.
  const allHours = (visibleLocIds.length ? visibleLocIds.map(hoursOf) : [tenant!.settings.hours]).map(range);
  const evMins = columns.flatMap((c) => c.events.flatMap((e) => [e.start.getHours() * 60 + e.start.getMinutes(), e.end.getHours() * 60 + e.end.getMinutes() || 24 * 60]));
  const startMin = Math.max(0, Math.floor(Math.min(...allHours.map((r) => r[0]), ...evMins) / 60) * 60);
  const endMin = Math.min(24 * 60, Math.ceil(Math.max(...allHours.map((r) => r[1]), ...evMins, startMin + 8 * 60) / 60) * 60);

  const step = view === 'week' ? 7 : 1;
  const rangeLabel =
    view === 'week'
      ? `${format(weekStart, 'd MMM', { locale: dateLocale() })} – ${format(addDays(weekStart, 6), 'd MMM yyyy', { locale: dateLocale() })}`
      : format(anchor, t('agenda.dayFormat'), { locale: dateLocale() });
  const teamLabel = isRestaurant ? t('agenda.viewTables') : isRentals ? t('agenda.viewSpaces') : t('agenda.viewTeam');
  const views: [View, string][] = [['day', t('agenda.viewDay')], ['week', t('agenda.viewWeek')], ...(teamAvailable ? [['team', teamLabel] as [View, string]] : [])];

  return (
    <>
      <PageHeader
        title={isRestaurant ? t('nav.reservations') : isRentals ? t('nav.bookings') : t('agenda.title')}
        actions={
          <button className="btn-primary" onClick={() => {
            const at = isSameDay(anchor, today) ? new Date() : new Date(new Date(anchor).setHours(10, 0, 0, 0));
            at.setMinutes(Math.ceil(at.getMinutes() / 30) * 30, 0, 0);
            newAt(at);
          }}>
            {isRestaurant ? t('tables.newReservation') : t('agenda.new')}
          </button>
        }
      />
      {unlinked && <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{t('roles.notLinked')}</p>}
      {scoped && !unlinked && <p className="mb-3 text-sm text-slate-500">{t('roles.onlyYours')}</p>}

      {/* Toolbar: today, prev/next, range, view switch */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <button className="btn-secondary !px-3 !py-1.5" onClick={() => setAnchor(startOfDay(new Date()))}>{t('agenda.today')}</button>
        <div className="flex">
          <button className="btn-secondary !rounded-r-none !px-3 !py-1.5" onClick={() => setAnchor(addDays(anchor, -step))} aria-label={t('agenda.prev')}>‹</button>
          <button className="btn-secondary !-ml-px !rounded-l-none !px-3 !py-1.5" onClick={() => setAnchor(addDays(anchor, step))} aria-label={t('agenda.next')}>›</button>
        </div>
        <h2 className="min-w-0 text-base font-semibold text-slate-800 first-letter:uppercase sm:text-lg">{rangeLabel}</h2>
        <div className="ml-auto flex items-center gap-3">
          <label className="hidden items-center gap-1.5 text-sm text-slate-600 sm:flex">
            <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
            {t('agenda.showCancelled')}
          </label>
          <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5" role="group" aria-label={t('agenda.view')}>
            {views.map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={`rounded-md px-3 py-1 text-sm font-medium ${view === v ? 'bg-brand-700 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {!scoped && locs.multi && (
        <div className="-mx-1 mb-2 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label={t('locations.title')}>
          {[{ id: '', name: t('locations.all') }, ...locs.list].map((l) => (
            <button
              key={l.id || 'all'}
              onClick={() => { setLoc(l.id); setFilter(''); }}
              aria-pressed={loc === l.id}
              className={`whitespace-nowrap rounded-lg border px-3 py-1 text-sm ${loc === l.id ? 'border-brand-700 bg-brand-700 text-white' : 'border-slate-300 bg-white text-slate-700'}`}
            >
              {l.id ? '⌂ ' : ''}{l.name}
            </button>
          ))}
        </div>
      )}
      {!scoped && resources.length > 1 && (
        <div className="-mx-1 mb-3 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label={t('agenda.filter')}>
          <button
            onClick={() => setFilter('')}
            aria-pressed={!filter}
            className={`whitespace-nowrap rounded-full border px-3 py-1 text-sm ${!filter ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-300 bg-white text-slate-700'}`}
          >
            {t('agenda.everyone')}
          </button>
          {resources.map((r) => (
            <button
              key={r.id}
              onClick={() => setFilter(filter === r.id ? '' : r.id)}
              aria-pressed={filter === r.id}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1 text-sm ${filter === r.id ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-300 bg-white text-slate-700'}`}
            >
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: r.color }} />
              {r.name}
            </button>
          ))}
        </div>
      )}

      {/* Day strip to jump within the week (day and team views) */}
      {view !== 'week' && (
        <div className="-mx-1 mb-3 flex gap-1 overflow-x-auto px-1 pb-1" role="group" aria-label={t('agenda.pickDay')}>
          {weekDays.map((d) => {
            const sel = isSameDay(d, anchor);
            const n = toEvents(onDay(d), false).length;
            return (
              <button
                key={d.toISOString()}
                type="button"
                onClick={() => setAnchor(startOfDay(d))}
                aria-pressed={sel}
                className={`flex min-w-[3.25rem] flex-1 flex-col items-center rounded-lg border px-2 py-1 ${sel ? 'border-brand-700 bg-brand-700 text-white' : isSameDay(d, today) ? 'border-brand-500 bg-white text-brand-700' : 'border-slate-200 bg-white text-slate-700'}`}
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
          maxLanes={view === 'week' ? 3 : view === 'team' ? 3 : 6}
          minColWidth={view === 'week' ? 120 : view === 'team' ? 150 : 200}
          slotMinutes={tenant?.settings.hours.slotMinutes ?? 30}
          formatHour={(h) => (i18n.language.startsWith('en') ? format(new Date(2000, 0, 1, h), 'h a') : `${String(h).padStart(2, '0')}:00`)}
          formatRange={fmtRange}
          formatTime={fmtTime}
          createLabel={t('agenda.tapToCreate')}
          moreLabel={(n) => t('agenda.more', { count: n })}
        />
      )}
      <p className="mt-2 text-xs text-slate-500">{t('agenda.tapToCreate')}</p>

      {creating && (
        <NewAppointmentModal initial={creating.at} defaultLocation={creating.locationId ?? loc} preset={creating.preset} onClose={() => setCreating(null)} />
      )}
      {selected && <AppointmentModal appt={selected} onClose={() => setSelected(null)} />}
      {classGroup && (
        <Modal open title={`${classGroup[0]!.serviceName} · ${fmtRange(new Date(classGroup[0]!.startsAt), new Date(classGroup[0]!.endsAt))}`} onClose={() => setClassGroup(null)}>
          <ul className="divide-y divide-slate-100">
            {classGroup.map((a) => (
              <li key={a.id}>
                <button type="button" className="flex w-full items-center justify-between gap-2 py-2 text-left hover:bg-slate-50" onClick={() => { setClassGroup(null); setSelected(a); }}>
                  <span className="text-sm font-medium text-slate-800">{a.customerName}{(a.partySize ?? 1) > 1 ? ` ×${a.partySize}` : ''}</span>
                  <StatusBadge status={a.status} />
                </button>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </>
  );
}

type Preset = { professionalId?: string; spaceId?: string; tableId?: string };

function NewAppointmentModal({ initial, defaultLocation, preset, onClose }: { initial: Date; defaultLocation: string; preset?: Preset; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { tenant, user } = useAuth();
  // Colaboradores book into their own agenda; the API enforces it too.
  const { scoped, professionalId: ownPro, locationId: ownLocation } = useAccess();
  const locs = useMyLocations(ownLocation);
  const [locationId, setLocationId] = useState(defaultLocation || ownLocation || '');
  // With one location there's nothing to choose; the API uses the main one.
  const effectiveLoc = locationId || locs.list[0]?.id || '';
  const atLoc = (x: { locationId: string }) => !effectiveLoc || x.locationId === effectiveLoc;
  const isRestaurant = tenant?.kind === 'reservations';
  const isRentals = tenant?.kind === 'rentals';
  const tables = useTables(isRestaurant);
  const pros = useProfessionals(tenant?.kind === 'appointments');
  const spaces = useSpaces(isRentals);
  const durations = rentalSettingsOf(tenant!.settings).durations;
  const [professionalId, setProfessionalId] = useState(preset?.professionalId ?? '');
  const [spaceId, setSpaceId] = useState(preset?.spaceId ?? '');
  const [partySize, setPartySize] = useState('2');
  const [tableId, setTableId] = useState(preset?.tableId ?? '');
  const services = useServices();
  const [search, setSearch] = useState('');
  const customers = useCustomers(search, 'name', scoped);
  const [customerId, setCustomerId] = useState('');
  const [newCustomer, setNewCustomer] = useState<{ name: string; phone: string } | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [startsAt, setStartsAt] = useState(toLocalInput(initial));
  const [duration, setDuration] = useState(isRentals ? String(durations[0]) : '');
  const [price, setPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [allowOverlap, setAllowOverlap] = useState(false);

  const active = (services.data ?? []).filter((s) => s.active);

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
          serviceId: isRentals ? undefined : serviceId || active[0]?.id,
          startsAt: new Date(startsAt).toISOString(),
          durationMin: duration ? Number(duration) : undefined,
          priceCents: isRestaurant ? 0 : price !== '' ? toCents(price) : undefined,
          notes: notes || null,
          allowOverlap,
          ...(isRestaurant ? { partySize: Number(partySize), tableId: tableId || null } : {}),
          ...(isRentals ? { spaceId: spaceId || null } : {}),
          ...(scoped ? (ownPro ? { professionalId: ownPro } : {}) : teamPros.length ? { professionalId: professionalId || null } : {}),
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

  const teamPros = (pros.data ?? []).filter((p) => p.active && (scoped || atLoc(p)));
  const eligible = eligibleProfessionals(teamPros, serviceId || active[0]?.id);
  const space = (spaces.data ?? []).find((x) => x.id === spaceId);
  const pickService = (id: string) => {
    setServiceId(id);
    const s = active.find((x) => x.id === id);
    if (s) {
      setDuration(String(s.durationMin));
      setPrice(String(s.priceCents / 100));
    }
  };

  return (
    <Modal open title={isRestaurant ? t('tables.newReservation') : t('agenda.new')} onClose={onClose}>
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
              onChange={(v) => { setLocationId(v); setProfessionalId(''); setTableId(''); setSpaceId(''); }}
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
        {isRestaurant ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">{t('tables.partySize')}</label>
              <input type="number" min={1} max={50} required className="input" value={partySize} onChange={(e) => setPartySize(e.target.value)} />
            </div>
            <div>
              <label className="label">{t('tables.table')}</label>
              <select className="input" value={tableId} onChange={(e) => setTableId(e.target.value)}>
                <option value="">{t('tables.auto')}</option>
                {(tables.data ?? []).filter((x) => x.active && atLoc(x) && x.seats >= Number(partySize || 1)).map((x) => (
                  <option key={x.id} value={x.id}>{x.name} · {t('tables.seatsN', { count: x.seats })}{x.area ? ` · ${x.area}` : ''}</option>
                ))}
              </select>
            </div>
          </div>
        ) : isRentals ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">{t('spaces.space')}</label>
              <select className="input" value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
                <option value="">{t('spaces.auto')}</option>
                {(spaces.data ?? []).filter((x) => x.active && atLoc(x)).map((x) => (
                  <option key={x.id} value={x.id}>{x.name} · {t('spaces.perHour', { price: money(x.pricePerHourCents) })}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{t('agenda.duration')}</label>
              <select className="input" value={duration} onChange={(e) => setDuration(e.target.value)}>
                {durations.map((m) => <option key={m} value={m}>{m} {t('common.minutes')}</option>)}
              </select>
            </div>
          </div>
        ) : (
        <div>
          <label className="label">{t('agenda.service')}</label>
          <select required className="input" value={serviceId} onChange={(e) => pickService(e.target.value)}>
            <option value="">{t('agenda.selectService')}</option>
            {active.map((s) => (
              <option key={s.id} value={s.id}>{s.name} · {s.durationMin} {t('common.minutes')} · {money(s.priceCents)}</option>
            ))}
          </select>
          {scoped && ownPro && (
            <p className="mt-2 text-sm text-slate-500">{t('roles.bookingFor', { name: teamPros.find((p) => p.id === ownPro)?.name ?? user?.name })}</p>
          )}
          {!scoped && teamPros.length > 0 && (
            <div className="mt-4">
              <label className="label">{t('team.professional')}</label>
              <select className="input" value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
                <option value="">{t('team.auto')}</option>
                {eligible.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
        </div>
        )}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-3">
            <label className="label">{t('agenda.startsAt')}</label>
            <input type="datetime-local" required className="input" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </div>
          {!isRentals && (
          <div>
            <label className="label">{t('agenda.duration')}</label>
            <input type="number" min={5} className="input" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </div>
          )}
          {!isRestaurant && (
          <div>
            <label className="label">{t('agenda.price')}</label>
            <input
              type="number"
              min={0}
              step="0.01"
              className="input"
              placeholder={isRentals && space ? String(spacePriceCents(space.pricePerHourCents, Number(duration)) / 100) : ''}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </div>
          )}
        </div>
        <div>
          <label className="label">{t('agenda.notes')}</label>
          <textarea className="input" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {!scoped && (
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={allowOverlap} onChange={(e) => setAllowOverlap(e.target.checked)} />
          {isRestaurant ? t('tables.noTable') : isRentals ? t('spaces.noSpace') : t('agenda.allowOverlap')}
        </label>
        )}
        <ErrorText error={create.error} ns={isRestaurant ? 'tables' : 'agenda'} />
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
  const tablesQ = useTables(appt.tableId != null || tenant?.kind === 'reservations');
  const prosQ = useProfessionals(tenant?.kind === 'appointments');
  const spacesQ = useSpaces(tenant?.kind === 'rentals');
  const teamPros = eligibleProfessionals((prosQ.data ?? []).filter((p) => p.active && p.locationId === appt.locationId), appt.serviceId);
  const [pro, setPro] = useState(appt.professionalId ?? '');
  const [spc, setSpc] = useState(appt.spaceId ?? '');
  const isTableBooking = tenant?.kind === 'reservations' && !appt.classSessionId;
  const [party, setParty] = useState(String(appt.partySize ?? 2));
  const [table, setTable] = useState(appt.tableId ?? '');
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

  const open = appt.status === 'scheduled' || appt.status === 'confirmed';
  const waLink = (url: string) =>
    appt.customerPhone
      ? `https://wa.me/${appt.customerPhone.replace(/\D/g, '')}?text=${encodeURIComponent(url)}`
      : undefined;

  return (
    <Modal open title={t('agenda.edit')} onClose={onClose}>
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <div className="text-lg font-semibold">{appt.customerName}</div>
          <StatusBadge status={appt.status} />
        </div>
        <div className="text-slate-600">{appt.serviceName}</div>
        <div className="text-sm text-slate-500">{dateTime(appt.startsAt)} – {timeOnly(appt.endsAt)} · {t(`source.${appt.source}`)}</div>
        {isTableBooking && appt.partySize != null && (
          <div className="text-sm font-medium text-slate-700">
            {t('tables.people', { count: appt.partySize })} · {appt.tableName ?? t('tables.unassigned')}
          </div>
        )}
        {(appt.professionalName || appt.spaceName) && (
          <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
            {appt.professionalColor && <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: appt.professionalColor }} />}
            {appt.professionalName ?? appt.spaceName}
          </div>
        )}
        {apptLocs.anyMulti && <div className="text-sm text-slate-500">⌂ {apptLocs.byId.get(appt.locationId)?.name}</div>}
        {appt.customerPhone && <div className="text-sm text-slate-500">{appt.customerPhone}</div>}
        {appt.notes && <p className="mt-2 rounded-lg bg-slate-50 p-2 text-sm">{appt.notes}</p>}
        <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center text-sm">
          <div><div className="text-slate-500">{t('agenda.price')}</div><div className="font-semibold">{money(appt.priceCents)}</div></div>
          <div><div className="text-slate-500">{t('agenda.paid')}</div><div className="font-semibold text-emerald-700">{money(appt.paidCents)}</div></div>
          <div><div className="text-slate-500">{t('agenda.outstanding')}</div><div className="font-semibold text-amber-700">{money(outstanding)}</div></div>
        </div>
      </div>

      {open && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap gap-2">
            {appt.status === 'scheduled' && (
              <button className="btn-secondary" onClick={() => update.mutate({ status: 'confirmed' })}>{t('agenda.confirm')}</button>
            )}
            <button className="btn-secondary" onClick={() => update.mutate({ status: 'no_show' })}>{t('agenda.noShow')}</button>
            <button className="btn-secondary text-rose-700" onClick={() => update.mutate({ status: 'cancelled' })}>{t('agenda.cancelAppt')}</button>
          </div>

          {!scoped && teamPros.length > 0 && !appt.classSessionId && (
            <div className="rounded-lg border border-slate-200 p-3">
              <label className="label">{t('team.professional')}</label>
              <div className="flex flex-wrap gap-2">
                <select className="input w-auto" value={pro} onChange={(e) => setPro(e.target.value)}>
                  <option value="">{t('team.auto')}</option>
                  {teamPros.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                <button className="btn-secondary" onClick={() => update.mutate({ professionalId: pro || null })}>{t('common.save')}</button>
              </div>
            </div>
          )}

          {tenant?.kind === 'rentals' && (
            <div className="rounded-lg border border-slate-200 p-3">
              <label className="label">{t('spaces.space')}</label>
              <div className="flex flex-wrap gap-2">
                <select className="input w-auto" value={spc} onChange={(e) => setSpc(e.target.value)}>
                  <option value="">{t('spaces.auto')}</option>
                  {(spacesQ.data ?? []).filter((x) => x.active && x.locationId === appt.locationId).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
                <button className="btn-secondary" onClick={() => update.mutate({ spaceId: spc || null })}>{t('common.save')}</button>
              </div>
            </div>
          )}

          {isTableBooking && appt.partySize != null && (
            <div className="rounded-lg border border-slate-200 p-3">
              <label className="label">{t('tables.table')}</label>
              <div className="flex flex-wrap gap-2">
                <input type="number" min={1} max={50} className="input w-24" value={party} onChange={(e) => setParty(e.target.value)} aria-label={t('tables.partySize')} />
                <select className="input w-auto" value={table} onChange={(e) => setTable(e.target.value)}>
                  <option value="">{t('tables.auto')}</option>
                  {(tablesQ.data ?? []).filter((x) => x.active && x.locationId === appt.locationId && x.seats >= Number(party || 1)).map((x) => (
                    <option key={x.id} value={x.id}>{x.name} · {t('tables.seatsN', { count: x.seats })}</option>
                  ))}
                </select>
                <button className="btn-secondary" onClick={() => update.mutate({ partySize: Number(party), tableId: table || null })}>{t('common.save')}</button>
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
              {isTableBooking && appt.partySize != null && (
                <input type="number" min={0} step="0.01" className="input w-32" placeholder={t('tables.bill')} value={bill} onChange={(e) => setBill(e.target.value)} aria-label={t('tables.bill')} />
              )}
              <button className="btn-primary" onClick={() => update.mutate({ status: 'completed', paymentMethod: method, ...(isTableBooking && bill !== '' ? { priceCents: toCents(bill) } : {}) })}>
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

      <ErrorText error={update.error} ns={isTableBooking ? 'tables' : 'agenda'} />
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
