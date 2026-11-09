import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  format,
  startOfMonth,
  startOfYear,
  subDays,
  subMonths,
  subYears,
  endOfMonth,
  endOfYear,
} from 'date-fns';
import type { ReportDto, ReportGranularity, ReportKpis, ServiceDto } from '@agenda/shared';
import { ErrorText, Loading, Modal, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAccess, useAuth } from '../lib/auth';
import { useMyLocations, useProfessionals, useSpaces } from '../lib/queries';
import { dateLocale, money, percent } from '../lib/format';

const PRESETS = [
  'last7',
  'last30',
  'thisMonth',
  'lastMonth',
  'last3Months',
  'last6Months',
  'last12Months',
  'thisYear',
  'lastYear',
  'custom',
] as const;
type Preset = (typeof PRESETS)[number];

const ymd = (d: Date) => format(d, 'yyyy-MM-dd');
const parseYmd = (s: string) => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};

export function presetRange(p: Preset, today = new Date()): { from: string; to: string } {
  const m0 = startOfMonth(today);
  switch (p) {
    case 'last7':
      return { from: ymd(subDays(today, 6)), to: ymd(today) };
    case 'last30':
      return { from: ymd(subDays(today, 29)), to: ymd(today) };
    case 'lastMonth':
      return { from: ymd(subMonths(m0, 1)), to: ymd(subDays(m0, 1)) };
    case 'last3Months':
      return { from: ymd(subMonths(m0, 2)), to: ymd(endOfMonth(today)) };
    case 'last6Months':
      return { from: ymd(subMonths(m0, 5)), to: ymd(endOfMonth(today)) };
    case 'last12Months':
      return { from: ymd(subMonths(m0, 11)), to: ymd(endOfMonth(today)) };
    case 'thisYear':
      return { from: ymd(startOfYear(today)), to: ymd(endOfYear(today)) };
    case 'lastYear': {
      const ly = subYears(today, 1);
      return { from: ymd(startOfYear(ly)), to: ymd(endOfYear(ly)) };
    }
    default:
      return { from: ymd(m0), to: ymd(endOfMonth(today)) };
  }
}

const WIDGETS = [
  'kpis',
  'revenue',
  'appointments',
  'newCustomers',
  'services',
  'methods',
  'sources',
  'weekday',
  'heatmap',
  'topCustomers',
] as const;
type Widget = (typeof WIDGETS)[number];
const WIDGET_KEY = 'agenda.reports.widgets';

function loadWidgets(): Widget[] {
  try {
    const raw = localStorage.getItem(WIDGET_KEY);
    if (raw) {
      const list = (JSON.parse(raw) as string[]).filter((w): w is Widget => (WIDGETS as readonly string[]).includes(w));
      if (list.length) return list;
    }
  } catch {
    /* storage unavailable */
  }
  return [...WIDGETS];
}

const BRAND = '#0f766e';
const PREV = '#94a3b8';
const C = {
  completed: '#0f766e',
  pending: '#38bdf8',
  no_show: '#f59e0b',
  cancelled: '#f43f5e',
};
const METHOD_COLORS = ['#0f766e', '#0ea5e9', '#8b5cf6', '#f59e0b', '#64748b'];

const LOWER_IS_BETTER: ReadonlySet<keyof ReportKpis> = new Set<keyof ReportKpis>(['noShowRate', 'cancellationRate', 'noShows', 'cancelled']);

function Delta({ cur, prev, k, rate }: { cur: number; prev: number; k: keyof ReportKpis; rate?: boolean }) {
  const { t } = useTranslation();
  if (rate) {
    const diff = cur - prev;
    if (Math.abs(diff) < 0.0005) return <span className="text-xs text-slate-400">= {t('reports.vsPrev')}</span>;
    const good = LOWER_IS_BETTER.has(k) ? diff < 0 : diff > 0;
    return (
      <span className={`text-xs ${good ? 'text-emerald-700' : 'text-rose-700'}`}>
        {diff > 0 ? '▲' : '▼'} {Math.abs(diff * 100).toFixed(1)} pts {t('reports.vsPrev')}
      </span>
    );
  }
  if (prev === 0) return cur === 0 ? null : <span className="text-xs text-slate-400">{t('reports.noPrev')}</span>;
  const d = (cur - prev) / prev;
  if (Math.abs(d) < 0.005) return <span className="text-xs text-slate-400">= {t('reports.vsPrev')}</span>;
  const good = LOWER_IS_BETTER.has(k) ? d < 0 : d > 0;
  return (
    <span className={`text-xs ${good ? 'text-emerald-700' : 'text-rose-700'}`}>
      {d > 0 ? '▲' : '▼'} {percent(Math.abs(d))} {t('reports.vsPrev')}
    </span>
  );
}

function Card({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <h2 className="mb-4 font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function ReportsPage() {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [widgets, setWidgets] = useState<Widget[]>(loadWidgets);
  const [customizing, setCustomizing] = useState(false);

  const { tenant } = useAuth();
  const { scoped, locationId: ownLocation } = useAccess();
  const locs = useMyLocations(ownLocation);
  const isRentals = tenant?.kind === 'rentals';
  const preset = (PRESETS as readonly string[]).includes(params.get('p') ?? '') ? (params.get('p') as Preset) : 'last3Months';
  const range = preset === 'custom'
    ? { from: params.get('from') ?? presetRange('thisMonth').from, to: params.get('to') ?? presetRange('thisMonth').to }
    : presetRange(preset);
  const granularity = (params.get('g') ?? '') as ReportGranularity | '';
  const serviceId = params.get('service') ?? '';
  const who = params.get('who') ?? '';
  const loc = params.get('loc') ?? '';
  const source = params.get('source') ?? '';
  const compare = params.get('compare') !== '0';

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  const qs = new URLSearchParams({ from: range.from, to: range.to });
  if (granularity) qs.set('granularity', granularity);
  if (serviceId) qs.set('serviceId', serviceId);
  if (who && !scoped) qs.set(isRentals ? 'spaceId' : 'professionalId', who);
  if (source) qs.set('source', source);
  if (loc && !ownLocation) qs.set('locationId', loc);

  const report = useQuery({
    queryKey: ['reports', qs.toString()],
    queryFn: () => api<ReportDto>(`/reports?${qs.toString()}`),
    placeholderData: keepPreviousData,
    enabled: range.from <= range.to,
  });
  const services = useQuery({ queryKey: ['services'], queryFn: () => api<ServiceDto[]>('/services') });
  const pros = useProfessionals(!isRentals);
  const spaces = useSpaces(isRentals);
  const resources: { id: string; name: string; active: boolean }[] = ((isRentals ? spaces.data : pros.data) ?? []).filter((x) => !loc || x.locationId === loc);

  const intl = i18n.language.startsWith('en') ? 'en-US' : 'es-MX';
  const data = report.data;
  const g = data?.granularity ?? 'day';

  const bucketLabel = (b: string) => {
    const d = parseYmd(b);
    if (g === 'month') return format(d, 'MMM yy', { locale: dateLocale() });
    return format(d, 'd MMM', { locale: dateLocale() });
  };

  const rows = useMemo(() => {
    if (!data) return [];
    return data.series.map((p, i) => {
      const prev = data.previousSeries[i];
      return {
        label: bucketLabel(p.bucket),
        bucket: p.bucket,
        revenue: p.revenueCents / 100,
        prevRevenue: prev ? prev.revenueCents / 100 : null,
        completed: p.completed,
        pending: Math.max(0, p.appointments - p.completed - p.noShows),
        noShows: p.noShows,
        cancelled: p.cancelled,
        appointments: p.appointments,
        prevAppointments: prev ? prev.appointments : null,
        newCustomers: p.newCustomers,
        prevNewCustomers: prev ? prev.newCustomers : null,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, i18n.language]);

  const weekdayFmt = new Intl.DateTimeFormat(intl, { weekday: 'short' });
  const weekdayName = (n: number) => weekdayFmt.format(new Date(2024, 0, n));

  const exportCsv = () => {
    if (!data) return;
    const header = ['bucket', 'revenue_mxn', 'appointments', 'completed', 'no_shows', 'cancelled', 'new_customers'];
    const lines = data.series.map((p) =>
      [p.bucket, (p.revenueCents / 100).toFixed(2), p.appointments, p.completed, p.noShows, p.cancelled, p.newCustomers].join(','),
    );
    const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `reporte_${range.from}_${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const toggleWidget = (w: Widget) => {
    const next = widgets.includes(w) ? widgets.filter((x) => x !== w) : WIDGETS.filter((x) => x === w || widgets.includes(x));
    setWidgets(next);
    try {
      localStorage.setItem(WIDGET_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const show = (w: Widget) => widgets.includes(w);

  const k = data?.kpis;
  const pk = data?.previousKpis;
  const fmtRange = (r: { from: string; to: string }) =>
    `${format(parseYmd(r.from), 'd MMM yyyy', { locale: dateLocale() })} – ${format(parseYmd(r.to), 'd MMM yyyy', { locale: dateLocale() })}`;

  const kpiDefs: { key: keyof ReportKpis; label: string; fmt: (v: number) => string; rate?: boolean; sub?: string }[] = k
    ? [
        { key: 'revenueCents', label: t('reports.kpi.revenue'), fmt: money },
        { key: 'appointments', label: t('reports.kpi.appointments'), fmt: String, sub: t('reports.kpi.completedOf', { count: k.completed }) },
        { key: 'avgTicketCents', label: t('reports.kpi.avgTicket'), fmt: money },
        { key: 'newCustomers', label: t('reports.kpi.newCustomers'), fmt: String },
        { key: 'activeCustomers', label: t('reports.kpi.activeCustomers'), fmt: String, sub: t('reports.kpi.returning', { count: k.returningCustomers }) },
        { key: 'noShowRate', label: t('reports.kpi.noShowRate'), fmt: percent, rate: true, sub: t('reports.kpi.count', { count: k.noShows }) },
        { key: 'cancellationRate', label: t('reports.kpi.cancellationRate'), fmt: percent, rate: true, sub: t('reports.kpi.count', { count: k.cancelled }) },
        { key: 'onlineShare', label: t('reports.kpi.onlineShare'), fmt: percent, rate: true },
      ]
    : [];

  const tickMoney = (v: number) => (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${v}`);
  const maxHeat = Math.max(1, ...(data?.heatmap.map((h) => h.count) ?? [1]));
  const heatHours = useMemo(() => {
    const hrs = data?.heatmap.map((h) => h.hour) ?? [];
    if (!hrs.length) return [] as number[];
    const lo = Math.min(...hrs);
    const hi = Math.max(...hrs);
    return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  }, [data]);

  return (
    <>
      <PageHeader
        title={t('reports.title')}
        actions={
          <>
            <button className="btn-secondary" onClick={() => setCustomizing(true)}>{t('reports.customize')}</button>
            <button className="btn-secondary" onClick={exportCsv} disabled={!data}>{t('reports.exportCsv')}</button>
          </>
        }
      />

      {/* Filters */}
      <div className="card mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t('reports.period')}</span>
          <select
            className="input"
            value={preset}
            onChange={(e) => {
              const p = e.target.value as Preset;
              if (p === 'custom') set({ p, from: range.from, to: range.to });
              else set({ p, from: null, to: null });
            }}
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>{t(`reports.presets.${p}`)}</option>
            ))}
          </select>
        </label>
        {preset === 'custom' ? (
          <div className="grid grid-cols-2 gap-2 text-sm">
            <label>
              <span className="mb-1 block text-slate-600">{t('reports.from')}</span>
              <input type="date" className="input" value={range.from} max={range.to} onChange={(e) => e.target.value && set({ from: e.target.value })} />
            </label>
            <label>
              <span className="mb-1 block text-slate-600">{t('reports.to')}</span>
              <input type="date" className="input" value={range.to} min={range.from} onChange={(e) => e.target.value && set({ to: e.target.value })} />
            </label>
          </div>
        ) : (
          <div className="flex items-end pb-2 text-sm text-slate-500">{fmtRange(range)}</div>
        )}
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t('reports.groupBy')}</span>
          <select className="input" value={granularity} onChange={(e) => set({ g: e.target.value })}>
            <option value="">{t('reports.auto')}</option>
            <option value="day">{t('reports.granularity.day')}</option>
            <option value="week">{t('reports.granularity.week')}</option>
            <option value="month">{t('reports.granularity.month')}</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t('reports.service')}</span>
          <select className="input" value={serviceId} onChange={(e) => set({ service: e.target.value })}>
            <option value="">{t('reports.all')}</option>
            {services.data?.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.active ? '' : ` (${t('services.inactive')})`}</option>
            ))}
          </select>
        </label>
        {!scoped && !ownLocation && locs.multi && (
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">{t('locations.location')}</span>
            <select className="input" value={loc} onChange={(e) => set({ loc: e.target.value, who: null })}>
              <option value="">{t('reports.all')}</option>
              {locs.list.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
        {!scoped && resources.length > 1 && (
          <label className="text-sm">
            <span className="mb-1 block text-slate-600">{isRentals ? t('spaces.space') : t('team.professional')}</span>
            <select className="input" value={who} onChange={(e) => set({ who: e.target.value })}>
              <option value="">{t('reports.all')}</option>
              {resources.map((u) => (
                <option key={u.id} value={u.id}>{u.name}{u.active ? '' : ` (${t('services.inactive')})`}</option>
              ))}
            </select>
          </label>
        )}
        <label className="text-sm">
          <span className="mb-1 block text-slate-600">{t('reports.source')}</span>
          <select className="input" value={source} onChange={(e) => set({ source: e.target.value })}>
            <option value="">{t('reports.all')}</option>
            <option value="online">{t('source.online')}</option>
            <option value="staff">{t('source.staff')}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={compare} onChange={(e) => set({ compare: e.target.checked ? null : '0' })} />
          {t('reports.compare')}
        </label>
        {(serviceId || who || source || granularity) && (
          <button className="self-end pb-2 text-left text-sm text-brand-700" onClick={() => set({ service: null, who: null, source: null, g: null })}>
            {t('reports.clear')}
          </button>
        )}
      </div>

      {range.from > range.to && <p className="mb-4 text-sm text-rose-700">{t('reports.invalidRange')}</p>}
      <ErrorText error={report.error} ns="reports" />
      {report.isLoading && <Loading />}

      {data && k && pk && (
        <div className={report.isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
          {compare && (
            <p className="mb-4 text-xs text-slate-500">
              {t('reports.comparing', { range: fmtRange(data.previousRange) })}
            </p>
          )}

          {show('kpis') && (
            <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
              {kpiDefs.map((d) => (
                <div key={d.key} className="card">
                  <div className="text-sm text-slate-500">{d.label}</div>
                  <div className="mt-1 text-2xl font-semibold text-slate-900">{d.fmt(k[d.key])}</div>
                  {d.sub && <div className="text-xs text-slate-500">{d.sub}</div>}
                  {compare && <Delta cur={k[d.key]} prev={pk[d.key]} k={d.key} rate={d.rate} />}
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            {show('revenue') && (
              <Card title={t('reports.charts.revenue')} className="lg:col-span-2">
                <div className="h-72">
                  <ResponsiveContainer>
                    <ComposedChart data={rows} margin={{ left: 4, right: 8 }}>
                      <CartesianGrid vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} minTickGap={12} />
                      <YAxis tickLine={false} axisLine={false} fontSize={12} width={48} tickFormatter={tickMoney} />
                      <Tooltip formatter={(v) => money(Number(v) * 100)} cursor={{ fill: '#f1f5f9' }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="revenue" name={t('reports.current')} fill={BRAND} radius={[4, 4, 0, 0]} />
                      {compare && (
                        <Line dataKey="prevRevenue" name={t('reports.previous')} stroke={PREV} strokeDasharray="4 4" strokeWidth={2} dot={false} />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            )}

            {show('appointments') && (
              <Card title={t('reports.charts.appointments')}>
                <div className="h-64">
                  <ResponsiveContainer>
                    <ComposedChart data={rows}>
                      <CartesianGrid vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} minTickGap={12} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} width={32} />
                      <Tooltip cursor={{ fill: '#f1f5f9' }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar stackId="a" dataKey="completed" name={t('status.completed')} fill={C.completed} />
                      <Bar stackId="a" dataKey="pending" name={t('reports.pending')} fill={C.pending} />
                      <Bar stackId="a" dataKey="noShows" name={t('status.no_show')} fill={C.no_show} />
                      <Bar stackId="a" dataKey="cancelled" name={t('status.cancelled')} fill={C.cancelled} radius={[4, 4, 0, 0]} />
                      {compare && (
                        <Line dataKey="prevAppointments" name={t('reports.previous')} stroke={PREV} strokeDasharray="4 4" strokeWidth={2} dot={false} />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            )}

            {show('newCustomers') && (
              <Card title={t('reports.charts.newCustomers')}>
                <div className="h-64">
                  <ResponsiveContainer>
                    <ComposedChart data={rows}>
                      <CartesianGrid vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} minTickGap={12} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} width={32} />
                      <Tooltip cursor={{ fill: '#f1f5f9' }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="newCustomers" name={t('reports.current')} fill="#0ea5e9" radius={[4, 4, 0, 0]} />
                      {compare && (
                        <Line dataKey="prevNewCustomers" name={t('reports.previous')} stroke={PREV} strokeDasharray="4 4" strokeWidth={2} dot={false} />
                      )}
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            )}

            {show('services') && (
              <Card title={t('reports.charts.services')}>
                {data.byService.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('dashboard.noData')}</p>
                ) : (
                  <div style={{ height: Math.max(160, data.byService.length * 36) }}>
                    <ResponsiveContainer>
                      <BarChart data={data.byService.map((s) => ({ ...s, revenue: s.revenueCents / 100 }))} layout="vertical" margin={{ left: 8, right: 48 }}>
                        <XAxis type="number" hide />
                        <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} fontSize={12} width={130} />
                        <Tooltip formatter={(v, name) => (name === 'revenue' ? money(Number(v) * 100) : v)} cursor={{ fill: '#f1f5f9' }} />
                        <Bar dataKey="count" name={t('reports.completedAppts')} fill={BRAND} radius={[0, 4, 4, 0]} label={{ position: 'right', fontSize: 12 }} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Card>
            )}

            {(data.byLocation?.length ?? 0) > 1 && (
              <Card title={t('reports.charts.locations')}>
                <ul className="space-y-3">
                  {data.byLocation.map((r) => {
                    const top = Math.max(...data.byLocation.map((x) => x.revenueCents), 1);
                    return (
                      <li key={r.id}>
                        <div className="mb-1 flex justify-between text-sm">
                          <span>⌂ {r.name} <span className="text-slate-400">· {t('reports.bookingsN', { count: r.count })}</span></span>
                          <span className="font-medium">{money(r.revenueCents)}</span>
                        </div>
                        <div className="h-2 rounded-full bg-slate-100">
                          <div className="h-2 rounded-full" style={{ width: `${(r.revenueCents / top) * 100}%`, background: BRAND }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}

            {(data.byProfessional.length > 0 || data.bySpace.length > 0) && (
              <Card title={data.bySpace.length ? t('reports.charts.spaces') : t('reports.charts.professionals')}>
                <ul className="space-y-3">
                  {(data.bySpace.length ? data.bySpace.map((x) => ({ ...x, color: BRAND })) : data.byProfessional).map((r) => {
                    const top = Math.max(...(data.bySpace.length ? data.bySpace : data.byProfessional).map((x) => x.revenueCents), 1);
                    return (
                      <li key={r.id}>
                        <div className="mb-1 flex justify-between text-sm">
                          <span>{r.name} <span className="text-slate-400">· {t('reports.bookingsN', { count: r.count })}</span></span>
                          <span className="font-medium">{money(r.revenueCents)}</span>
                        </div>
                        <div className="h-2 rounded-full bg-slate-100">
                          <div className="h-2 rounded-full" style={{ width: `${(r.revenueCents / top) * 100}%`, background: r.color }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            )}

            {show('methods') && (
              <Card title={t('reports.charts.methods')}>
                {data.byMethod.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('dashboard.noData')}</p>
                ) : (
                  <ul className="space-y-3">
                    {data.byMethod.map((m, i) => {
                      const share = k.revenueCents > 0 ? m.revenueCents / k.revenueCents : 0;
                      return (
                        <li key={m.method}>
                          <div className="mb-1 flex justify-between text-sm">
                            <span>{t(`methods.${m.method}`)} <span className="text-slate-400">· {m.count}</span></span>
                            <span className="font-medium">{money(m.revenueCents)} <span className="text-slate-400">({percent(share)})</span></span>
                          </div>
                          <div className="h-2 rounded-full bg-slate-100">
                            <div className="h-2 rounded-full" style={{ width: `${share * 100}%`, background: METHOD_COLORS[i % METHOD_COLORS.length] }} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            )}

            {show('sources') && (
              <Card title={t('reports.charts.sources')}>
                {data.bySource.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('dashboard.noData')}</p>
                ) : (
                  <ul className="space-y-3">
                    {(['online', 'staff'] as const).map((s) => {
                      const count = data.bySource.find((x) => x.source === s)?.count ?? 0;
                      const share = k.appointments > 0 ? count / k.appointments : 0;
                      return (
                        <li key={s}>
                          <div className="mb-1 flex justify-between text-sm">
                            <span>{t(`source.${s}`)}</span>
                            <span className="font-medium">{count} <span className="text-slate-400">({percent(share)})</span></span>
                          </div>
                          <div className="h-2 rounded-full bg-slate-100">
                            <div className="h-2 rounded-full" style={{ width: `${share * 100}%`, background: s === 'online' ? '#0ea5e9' : BRAND }} />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </Card>
            )}

            {show('weekday') && (
              <Card title={t('dashboard.byWeekday')}>
                <div className="h-56">
                  <ResponsiveContainer>
                    <BarChart data={[1, 2, 3, 4, 5, 6, 7].map((d) => ({ label: weekdayName(d), count: data.byWeekday.find((w) => w.weekday === d)?.count ?? 0 }))}>
                      <CartesianGrid vertical={false} stroke="#e2e8f0" />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
                      <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} width={32} />
                      <Tooltip cursor={{ fill: '#f1f5f9' }} />
                      <Bar dataKey="count" name={t('dashboard.appointments')} fill={BRAND} radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </Card>
            )}

            {show('heatmap') && (
              <Card title={t('reports.charts.heatmap')}>
                {heatHours.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('dashboard.noData')}</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full border-separate border-spacing-1 text-xs">
                      <thead>
                        <tr>
                          <th />
                          {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                            <th key={d} className="font-medium capitalize text-slate-500">{weekdayName(d)}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {heatHours.map((h) => (
                          <tr key={h}>
                            <td className="pr-1 text-right text-slate-500">{String(h).padStart(2, '0')}:00</td>
                            {[1, 2, 3, 4, 5, 6, 7].map((d) => {
                              const v = data.heatmap.find((x) => x.weekday === d && x.hour === h)?.count ?? 0;
                              const a = v / maxHeat;
                              return (
                                <td
                                  key={d}
                                  title={`${weekdayName(d)} ${h}:00 · ${v}`}
                                  className="h-6 min-w-8 rounded text-center"
                                  style={{ background: v ? `rgba(15,118,110,${0.12 + a * 0.88})` : '#f1f5f9', color: a > 0.55 ? 'white' : '#334155' }}
                                >
                                  {v || ''}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            )}

            {show('topCustomers') && (
              <Card title={t('dashboard.topCustomers')}>
                {data.topCustomers.length === 0 ? (
                  <p className="text-sm text-slate-500">{t('dashboard.noData')}</p>
                ) : (
                  <ol className="divide-y divide-slate-100">
                    {data.topCustomers.map((c, i) => (
                      <li key={c.id} className="flex items-center justify-between gap-2 py-2">
                        <span className="flex items-center gap-2">
                          <span className="w-5 text-right text-xs text-slate-400">{i + 1}</span>
                          <Link to={`/customers/${c.id}`} className="font-medium text-slate-800 hover:text-brand-700">{c.name}</Link>
                        </span>
                        <span className="text-right">
                          <span className="block font-medium">{money(c.totalSpentCents)}</span>
                          <span className="block text-xs text-slate-500">{t('dashboard.visits', { count: c.visits })}</span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            )}
          </div>
        </div>
      )}

      <Modal open={customizing} title={t('reports.customize')} onClose={() => setCustomizing(false)}>
        <p className="mb-3 text-sm text-slate-600">{t('reports.customizeHelp')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {WIDGETS.map((w) => (
            <label key={w} className="flex items-center gap-2 rounded-lg border border-slate-200 p-2 text-sm">
              <input type="checkbox" checked={widgets.includes(w)} onChange={() => toggleWidget(w)} />
              {t(`reports.widgets.${w}`)}
            </label>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <button className="btn-primary" onClick={() => setCustomizing(false)}>{t('common.close')}</button>
        </div>
      </Modal>
    </>
  );
}
