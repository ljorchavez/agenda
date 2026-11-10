import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';

/**
 * Time-grid calendar (Microsoft Teams / Outlook style): hours down the left, one column per day
 * (or per person/table/space), bookings drawn as blocks sized by their duration.
 *
 * Readability rules:
 * - Rows are tall (zoomable) so a 30-minute booking fits name, time and service.
 * - At most `maxLanes` bookings sit side by side. The rest are not squeezed: they become a small
 *   "+N" chip at their own time slot that opens the full day.
 */

export interface CalEvent {
  id: string;
  start: Date;
  end: Date;
  color: string;
  title: string;
  /** Shorter title used when the block is narrow (e.g. "Ana G.") */
  shortTitle?: string;
  subtitle?: string | null;
  detail?: string | null;
  /** Small status mark shown before the title (✓, ✕ …) */
  icon?: string;
  /** Pill in the top-right corner (payment state: "$✓", "$!") */
  badge?: { text: string; className: string };
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
  /** Closed stretches (before opening, breaks, after closing). When set, used instead of `open` for shading. */
  closed?: [number, number][];
  /** Blocked times (vacations, holidays) drawn hatched; minutes from midnight of this column's day */
  blocks?: CalBlock[];
  events: CalEvent[];
  onCreate?: (at: Date) => void;
  onMore?: () => void;
}

export interface CalBlock {
  id: string;
  startMin: number;
  endMin: number;
  label: string;
  onClick?: () => void;
}

interface Props {
  columns: CalColumn[];
  /** Visible range, minutes from midnight (whole hours) */
  startMin: number;
  endMin: number;
  /** Bookings shown side by side before the rest turn into "+N" chips */
  maxLanes: number;
  minColWidth: number;
  pxPerHour: number;
  slotMinutes: number;
  /** Narrow screens: thinner hour column */
  compact?: boolean;
  formatHour: (hour: number) => string;
  formatRange: (start: Date, end: Date) => string;
  formatTime: (d: Date) => string;
  createLabel: string;
  moreLabel: (count: number) => string;
}

const MIN_EVENT_PX = 30;
const CHIP_LANE_PX = 36;
/** Narrowest card that still shows a readable name ("Jimena P.") and time */
const MIN_CARD_PX = 112;

const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

type Placed =
  | { kind: 'event'; ev: CalEvent; lane: number; lanes: number; chips: boolean }
  | { kind: 'more'; key: string; count: number; startMin: number; lanes: number };

/**
 * Assigns overlapping events to side-by-side lanes. Clusters wider than `maxLanes` keep the
 * first `maxLanes` lanes and group the hidden bookings into one "+N" chip per time slot.
 */
export function layoutEvents(events: CalEvent[], maxLanes: number, pxPerMin: number, slotMinutes: number): Placed[] {
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
      for (const c of cluster) out.push({ kind: 'event', ev: c.ev, lane: c.lane, lanes, chips: false });
    } else {
      const bySlot = new Map<number, number>();
      for (const c of cluster) {
        if (c.lane < maxLanes) out.push({ kind: 'event', ev: c.ev, lane: c.lane, lanes: maxLanes, chips: true });
        else {
          const slot = Math.floor(minutesOfDay(c.ev.start) / slotMinutes) * slotMinutes;
          bySlot.set(slot, (bySlot.get(slot) ?? 0) + 1);
        }
      }
      for (const [slot, count] of bySlot) {
        out.push({ kind: 'more', key: `more-${cluster[0]!.ev.id}-${slot}`, count, startMin: slot, lanes: maxLanes });
      }
    }
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };
  for (const ev of sorted) {
    const s = ev.start.getTime();
    // Very short bookings still take the minimum block height on screen.
    const e = Math.max(ev.end.getTime(), s + (MIN_EVENT_PX / pxPerMin) * 60000);
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
  muted: 'text-slate-600 opacity-75',
  cancelled: 'text-slate-500 opacity-60 line-through',
  alert: 'text-rose-900',
};

export function CalendarGrid(props: Props) {
  const { columns, startMin, endMin, maxLanes, minColWidth, slotMinutes, pxPerHour } = props;
  const pxPerMin = pxPerHour / 60;
  const gutter = props.compact ? 44 : 60;
  const height = ((endMin - startMin) / 60) * pxPerHour;
  const scroller = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => new Date());
  // Real column width decides how many bookings fit side by side, so cards never get too thin to read.
  const [boxWidth, setBoxWidth] = useState(0);
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => setBoxWidth(e!.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const colWidth = Math.max(minColWidth, columns.length ? (boxWidth - gutter) / columns.length : minColWidth);
  const lanesThatFit = Math.max(1, Math.floor((colWidth - CHIP_LANE_PX) / MIN_CARD_PX));
  const lanes = boxWidth ? Math.min(maxLanes, lanesThatFit) : maxLanes;
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
    el.scrollTop = Number.isFinite(target) ? Math.max(0, (target - startMin) * pxPerMin) : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey, startMin, pxPerHour]);

  const hours = useMemo(() => {
    const list: number[] = [];
    for (let m = Math.ceil(startMin / 60) * 60; m < endMin; m += 60) list.push(m / 60);
    return list;
  }, [startMin, endMin]);

  const template = `${gutter}px repeat(${columns.length}, minmax(${minColWidth}px, 1fr))`;
  const y = (min: number) => (min - startMin) * pxPerMin;

  const createAt = (col: CalColumn, e: MouseEvent<HTMLDivElement>) => {
    if (!col.onCreate) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const min = startMin + (e.clientY - rect.top) / pxPerMin;
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
      style={{ maxHeight: 'max(460px, calc(100dvh - 12.5rem))' }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: template, minWidth: gutter + columns.length * minColWidth }}>
        {/* Header row */}
        <div className="sticky left-0 top-0 z-30 border-b border-slate-200 bg-white" />
        {columns.map((c) => (
          <div
            key={`h-${c.key}`}
            className={`sticky top-0 z-20 border-b border-l border-slate-200 bg-white px-1 py-2 ${c.isToday ? 'shadow-[inset_0_-3px_0_0_var(--color-brand-600)]' : ''}`}
          >
            {c.header}
          </div>
        ))}

        {/* Hour labels */}
        <div className="sticky left-0 z-10 border-r border-slate-200 bg-white" style={{ height }} aria-hidden>
          {hours.map((h) => (
            <div
              key={h}
              className={`absolute right-2 text-xs font-medium text-slate-500 ${h * 60 === startMin ? 'translate-y-1' : '-translate-y-1/2'}`}
              style={{ top: y(h * 60) }}
            >
              {props.formatHour(h)}
            </div>
          ))}
        </div>

        {/* Day / resource columns */}
        {columns.map((col) => {
          const placed = layoutEvents(col.events, lanes, pxPerMin, slotMinutes);
          const nowMin = minutesOfDay(now);
          return (
            <div
              key={col.key}
              data-testid="calendar-column"
              className={`relative border-l border-slate-200 ${col.onCreate ? 'cursor-pointer' : ''}`}
              style={{
                height,
                backgroundImage:
                  'linear-gradient(to bottom, rgb(203 213 225) 1px, transparent 1px), linear-gradient(to bottom, rgb(241 245 249) 1px, transparent 1px)',
                backgroundSize: `100% ${pxPerHour}px, 100% ${pxPerHour / 2}px`,
                backgroundPosition: `0 ${y(Math.ceil(startMin / 60) * 60)}px, 0 ${y(Math.ceil(startMin / 30) * 30)}px`,
              }}
              onClick={(e) => createAt(col, e)}
              title={col.onCreate ? props.createLabel : undefined}
            >
              {/* Closed hours shaded, like non-working hours in Teams */}
              {col.closed ? (
                col.closed
                  .filter(([s0, e0]) => e0 > startMin && s0 < endMin)
                  .map(([s0, e0]) => (
                    <div
                      key={`closed-${s0}`}
                      className="pointer-events-none absolute inset-x-0 bg-slate-100/80"
                      style={{ top: y(Math.max(s0, startMin)), height: y(Math.min(e0, endMin)) - y(Math.max(s0, startMin)) }}
                    />
                  ))
              ) : col.open ? (
                <>
                  {col.open[0] > startMin && (
                    <div className="pointer-events-none absolute inset-x-0 top-0 bg-slate-100/80" style={{ height: y(col.open[0]) }} />
                  )}
                  {col.open[1] < endMin && (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-slate-100/80" style={{ top: y(col.open[1]) }} />
                  )}
                </>
              ) : (
                <div className="pointer-events-none absolute inset-0 bg-slate-100/80" />
              )}

              {(col.blocks ?? [])
                .filter((b) => b.endMin > startMin && b.startMin < endMin)
                .map((b) => {
                  const top = y(Math.max(b.startMin, startMin));
                  const bottom = y(Math.min(b.endMin, endMin));
                  return (
                    <button
                      key={`block-${b.id}`}
                      type="button"
                      data-testid="calendar-block"
                      disabled={!b.onClick}
                      title={b.label}
                      aria-label={b.label}
                      onClick={(e) => {
                        e.stopPropagation();
                        b.onClick?.();
                      }}
                      className="absolute inset-x-0 z-[4] overflow-hidden border-y border-slate-300 px-2 py-1 text-left text-xs font-medium text-slate-600 enabled:hover:bg-slate-200/40"
                      style={{
                        top,
                        height: Math.max(18, bottom - top),
                        backgroundImage: 'repeating-linear-gradient(135deg, rgb(148 163 184 / 0.22) 0 6px, transparent 6px 12px)',
                      }}
                    >
                      <span className="rounded bg-white/90 px-1">🔒 {b.label}</span>
                    </button>
                  );
                })}

              {placed.map((p) => {
                if (p.kind === 'more') {
                  return (
                    <button
                      key={p.key}
                      type="button"
                      data-testid="calendar-more"
                      className="absolute z-[5] flex items-start justify-center rounded-md border border-slate-300 bg-white pt-0.5 text-xs font-semibold text-brand-700 shadow-sm hover:bg-brand-50"
                      style={{ top: y(p.startMin) + 2, height: Math.max(MIN_EVENT_PX - 4, (slotMinutes * pxPerMin) - 4), right: 2, width: CHIP_LANE_PX - 4 }}
                      aria-label={props.moreLabel(p.count)}
                      title={props.moreLabel(p.count)}
                      onClick={(e) => {
                        e.stopPropagation();
                        col.onMore?.();
                      }}
                    >
                      +{p.count}
                    </button>
                  );
                }
                const ev = p.ev;
                // With a "+N" lane, events share the width left of it.
                const avail = p.chips ? `(100% - ${CHIP_LANE_PX}px)` : '100%';
                const left = `calc(${avail} * ${p.lane / p.lanes} + 3px)`;
                const width = `calc(${avail} / ${p.lanes} - 6px)`;
                // Short name ("Ana G.") whenever the card is thin, not only when bookings sit side by side.
                const cardPx = (colWidth - (p.chips ? CHIP_LANE_PX : 0)) / p.lanes - 6;
                const narrow = p.lanes > 1 || cardPx < 170;
                const startM = minutesOfDay(ev.start);
                const dur = Math.max(1, (ev.end.getTime() - ev.start.getTime()) / 60000);
                const h = Math.max(MIN_EVENT_PX, dur * pxPerMin - 4);
                const oneLine = h < 44;
                const title = narrow && ev.shortTitle ? ev.shortTitle : ev.title;
                const accent = ev.tone === 'alert' ? '#e11d48' : ev.color;
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
                    className={`absolute z-[5] overflow-hidden rounded-lg pl-2.5 pr-1.5 text-left leading-tight shadow-sm ring-1 ring-black/5 transition hover:z-10 hover:shadow-md hover:ring-black/15 focus:z-10 focus:outline-none focus:ring-2 focus:ring-brand-500 ${oneLine ? 'flex items-center' : 'py-1.5'} ${TONE[ev.tone ?? 'normal']}`}
                    style={{
                      top: y(startM) + 2,
                      height: h,
                      left,
                      width,
                      background: ev.tone === 'alert' ? '#fff1f2' : `color-mix(in srgb, ${ev.color} 9%, white)`,
                      boxShadow: `inset 3px 0 0 ${accent}`,
                    }}
                  >
                    {oneLine ? (
                      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[13px]">
                        <span className="shrink-0 text-[11px] tabular-nums text-slate-500">{props.formatTime(ev.start)}</span>
                        <span className="truncate font-semibold">{ev.icon ? `${ev.icon} ` : ''}{title}</span>
                        {ev.badge && <span className={`ml-auto shrink-0 self-center rounded px-1 text-[10px] font-bold leading-4 ${ev.badge.className}`}>{ev.badge.text}</span>}
                      </span>
                    ) : (
                      <>
                        <div className="flex items-center gap-1 text-[11px] font-medium tabular-nums text-slate-500">
                          <span className="truncate">{narrow ? props.formatTime(ev.start) : props.formatRange(ev.start, ev.end)}</span>
                          {ev.badge && <span className={`ml-auto shrink-0 rounded px-1 text-[10px] font-bold leading-4 ${ev.badge.className}`}>{ev.badge.text}</span>}
                        </div>
                        <div className="truncate text-[13px] font-semibold">{ev.icon ? `${ev.icon} ` : ''}{title}</div>
                        {h >= 62 && ev.subtitle && <div className="mt-0.5 truncate text-xs text-slate-600">{ev.subtitle}</div>}
                        {h >= 80 && ev.detail && (
                          <div className="mt-0.5 flex items-center gap-1 truncate text-xs text-slate-500">
                            <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: ev.color }} />
                            <span className="truncate">{ev.detail}</span>
                          </div>
                        )}
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
