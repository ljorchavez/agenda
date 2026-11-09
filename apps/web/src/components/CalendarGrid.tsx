import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';

/**
 * Time-grid calendar (Microsoft Teams / Outlook style): hours down the left, one column per day
 * (or per person/table/space), bookings drawn as blocks sized by their duration. Overlapping
 * bookings sit side by side; when too many overlap, the extra ones collapse into "+N".
 */

export interface CalEvent {
  id: string;
  start: Date;
  end: Date;
  color: string;
  title: string;
  subtitle?: string | null;
  detail?: string | null;
  /** Small status mark shown before the title (✓, ✕ …) */
  icon?: string;
  tone?: 'normal' | 'muted' | 'cancelled' | 'alert';
  /** Full description for screen readers and the hover tooltip */
  label: string;
  onClick: () => void;
}

export interface CalColumn {
  key: string;
  /** Day shown in this column (any time of that day) */
  date: Date;
  header: ReactNode;
  isToday: boolean;
  /** Opening hours in minutes from midnight; null = closed that day */
  open: [number, number] | null;
  events: CalEvent[];
  onCreate?: (at: Date) => void;
  onMore?: () => void;
}

interface Props {
  columns: CalColumn[];
  /** Visible range, minutes from midnight (whole hours) */
  startMin: number;
  endMin: number;
  /** Max bookings side by side before collapsing into "+N" */
  maxLanes: number;
  minColWidth: number;
  slotMinutes: number;
  formatHour: (hour: number) => string;
  formatRange: (start: Date, end: Date) => string;
  formatTime: (d: Date) => string;
  createLabel: string;
  moreLabel: (count: number) => string;
}

const PX_PER_HOUR = 80;
const PX_PER_MIN = PX_PER_HOUR / 60;
const MIN_EVENT_PX = 22;
const GUTTER = 56;

const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

type Placed =
  | { kind: 'event'; ev: CalEvent; lane: number; lanes: number }
  | { kind: 'more'; key: string; count: number; start: Date; lane: number; lanes: number };

/** Assigns overlapping events to side-by-side lanes. */
export function layoutEvents(events: CalEvent[], maxLanes: number): Placed[] {
  const sorted = [...events].sort(
    (a, b) =>
      a.start.getTime() - b.start.getTime() ||
      b.end.getTime() - b.start.getTime() - (a.end.getTime() - a.start.getTime()),
  );
  const out: Placed[] = [];
  let cluster: { ev: CalEvent; lane: number }[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    if (!cluster.length) return;
    const lanes = laneEnds.length;
    if (lanes <= maxLanes) {
      for (const c of cluster) out.push({ kind: 'event', ev: c.ev, lane: c.lane, lanes });
    } else {
      const visible = Math.max(1, maxLanes - 1);
      const hidden = cluster.filter((c) => c.lane >= visible);
      for (const c of cluster) if (c.lane < visible) out.push({ kind: 'event', ev: c.ev, lane: c.lane, lanes: visible + 1 });
      const first = hidden.reduce((m, c) => (c.ev.start < m ? c.ev.start : m), hidden[0]!.ev.start);
      out.push({ kind: 'more', key: `more-${hidden[0]!.ev.id}`, count: hidden.length, start: first, lane: visible, lanes: visible + 1 });
    }
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };
  for (const ev of sorted) {
    const s = ev.start.getTime();
    // Very short bookings still take the minimum block height on screen.
    const e = Math.max(ev.end.getTime(), s + (MIN_EVENT_PX / PX_PER_MIN) * 60000);
    if (s >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= s);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(e);
    } else {
      laneEnds[lane] = e;
    }
    cluster.push({ ev, lane });
    clusterEnd = Math.max(clusterEnd, e);
  }
  flush();
  return out;
}

const TONE: Record<NonNullable<CalEvent['tone']>, string> = {
  normal: 'text-slate-900',
  muted: 'text-slate-600 opacity-80',
  cancelled: 'text-slate-500 opacity-60 line-through',
  alert: 'text-rose-900',
};

export function CalendarGrid(props: Props) {
  const { columns, startMin, endMin, maxLanes, minColWidth, slotMinutes } = props;
  const height = ((endMin - startMin) / 60) * PX_PER_HOUR;
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Open on the current time (or the first booking / opening time), like Teams does.
  const scrollKey = columns.map((c) => c.key).join('|');
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const today = columns.some((c) => c.isToday);
    const firstEvent = Math.min(...columns.flatMap((c) => c.events.map((e) => minutesOfDay(e.start))), Infinity);
    const firstOpen = Math.min(...columns.map((c) => c.open?.[0] ?? Infinity), Infinity);
    const target = today ? minutesOfDay(new Date()) - 60 : Math.min(firstEvent, firstOpen);
    el.scrollTop = Number.isFinite(target) ? Math.max(0, (target - startMin) * PX_PER_MIN) : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, startMin]);

  const hours = useMemo(() => {
    const list: number[] = [];
    for (let m = Math.ceil(startMin / 60) * 60; m < endMin; m += 60) list.push(m / 60);
    return list;
  }, [startMin, endMin]);

  const template = `${GUTTER}px repeat(${columns.length}, minmax(${minColWidth}px, 1fr))`;
  const y = (min: number) => (min - startMin) * PX_PER_MIN;

  const createAt = (col: CalColumn, e: MouseEvent<HTMLDivElement>) => {
    if (!col.onCreate) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const min = startMin + (e.clientY - rect.top) / PX_PER_MIN;
    const snapped = Math.floor(min / slotMinutes) * slotMinutes;
    const at = new Date(col.date);
    at.setHours(0, 0, 0, 0);
    at.setMinutes(snapped);
    col.onCreate(at);
  };

  return (
    <div
      ref={scroller}
      className="relative overflow-auto rounded-xl border border-slate-200 bg-white shadow-sm"
      style={{ maxHeight: 'max(440px, calc(100dvh - 16rem))' }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: template, minWidth: GUTTER + columns.length * minColWidth }}>
        {/* Header row */}
        <div className="sticky left-0 top-0 z-30 border-b border-slate-200 bg-white" />
        {columns.map((c) => (
          <div key={`h-${c.key}`} className="sticky top-0 z-20 border-b border-l border-slate-200 bg-white px-1 py-2">
            {c.header}
          </div>
        ))}

        {/* Hour labels */}
        <div className="sticky left-0 z-10 border-r border-slate-200 bg-white" style={{ height }} aria-hidden>
          {hours.map((h) => (
            <div key={h} className="absolute right-2 -translate-y-1/2 text-[11px] font-medium text-slate-500" style={{ top: y(h * 60) }}>
              {h * 60 === startMin ? '' : props.formatHour(h)}
            </div>
          ))}
        </div>

        {/* Day / resource columns */}
        {columns.map((col) => {
          const placed = layoutEvents(col.events, maxLanes);
          const nowMin = minutesOfDay(now);
          return (
            <div
              key={col.key}
              data-testid="calendar-column"
              className={`relative border-l border-slate-200 ${col.onCreate ? 'cursor-pointer' : ''}`}
              style={{
                height,
                backgroundImage:
                  'linear-gradient(to bottom, rgb(226 232 240) 1px, transparent 1px), linear-gradient(to bottom, rgb(241 245 249) 1px, transparent 1px)',
                backgroundSize: `100% ${PX_PER_HOUR}px, 100% ${PX_PER_HOUR / 2}px`,
                backgroundPosition: `0 ${y(Math.ceil(startMin / 60) * 60)}px, 0 ${y(Math.ceil(startMin / 30) * 30)}px`,
              }}
              onClick={(e) => createAt(col, e)}
              title={col.onCreate ? props.createLabel : undefined}
            >
              {/* Closed hours shaded, like non-working hours in Teams */}
              {col.open ? (
                <>
                  {col.open[0] > startMin && (
                    <div className="pointer-events-none absolute inset-x-0 top-0 bg-slate-100/70" style={{ height: y(col.open[0]) }} />
                  )}
                  {col.open[1] < endMin && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-slate-100/70" style={{ top: y(col.open[1]) }} />
                  )}
                </>
              ) : (
                <div className="pointer-events-none absolute inset-0 bg-slate-100/70" />
              )}

              {placed.map((p) => {
                const left = `calc(${(p.lane / p.lanes) * 100}% + 2px)`;
                const width = `calc(${100 / p.lanes}% - 4px)`;
                if (p.kind === 'more') {
                  return (
                    <button
                      key={p.key}
                      type="button"
                      className="absolute z-[5] rounded-md border border-slate-300 bg-white px-1 text-left text-xs font-semibold text-brand-700 shadow-sm hover:bg-brand-50"
                      style={{ top: y(minutesOfDay(p.start)) + 1, height: MIN_EVENT_PX, left, width }}
                      onClick={(e) => {
                        e.stopPropagation();
                        col.onMore?.();
                      }}
                    >
                      {props.moreLabel(p.count)}
                    </button>
                  );
                }
                const ev = p.ev;
                const startM = minutesOfDay(ev.start);
                const dur = Math.max(1, (ev.end.getTime() - ev.start.getTime()) / 60000);
                const h = Math.max(MIN_EVENT_PX, dur * PX_PER_MIN - 2);
                const compact = h < 34;
                return (
                  <button
                    key={ev.id}
                    type="button"
                    data-testid="calendar-event"
                    aria-label={ev.label}
                    title={ev.label}
                    onClick={(e) => {
                      e.stopPropagation();
                      ev.onClick();
                    }}
                    className={`absolute z-[5] overflow-hidden rounded-md px-1.5 text-left text-xs leading-tight shadow-sm ring-1 ring-black/5 transition hover:z-10 hover:shadow-md focus:z-10 focus:outline-none focus:ring-2 focus:ring-brand-500 ${compact ? 'flex items-center gap-1 py-0' : 'py-1'} ${TONE[ev.tone ?? 'normal']}`}
                    style={{
                      top: y(startM) + 1,
                      height: h,
                      left,
                      width,
                      background: ev.tone === 'alert' ? '#ffe4e6' : `${ev.color}1f`,
                      borderLeft: `3px solid ${ev.tone === 'alert' ? '#e11d48' : ev.color}`,
                    }}
                  >
                    {compact ? (
                      <span className="truncate">
                        <span className="font-semibold">{ev.icon ? `${ev.icon} ` : ''}{ev.title}</span>
                        <span className="text-slate-500"> · {props.formatTime(ev.start)}</span>
                      </span>
                    ) : (
                      <>
                        <div className="truncate font-semibold">{ev.icon ? `${ev.icon} ` : ''}{ev.title}</div>
                        <div className="truncate text-[11px] text-slate-600">{props.formatRange(ev.start, ev.end)}</div>
                        {h >= 50 && ev.subtitle && <div className="truncate text-[11px] text-slate-600">{ev.subtitle}</div>}
                        {h >= 66 && ev.detail && <div className="truncate text-[11px] text-slate-500">{ev.detail}</div>}
                      </>
                    )}
                  </button>
                );
              })}

              {col.isToday && nowMin >= startMin && nowMin <= endMin && (
                <div className="pointer-events-none absolute inset-x-0 z-[6]" style={{ top: y(nowMin) }} aria-hidden>
                  <div className="relative h-0.5 bg-rose-500">
                    <span className="absolute -left-1 -top-[3px] h-2 w-2 rounded-full bg-rose-500" />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
