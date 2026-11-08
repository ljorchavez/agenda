import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { addMonths, startOfMonth } from 'date-fns';
import type { DashboardDto } from '@agenda/shared';
import { Loading, PageHeader, StatusBadge } from '../components/ui';
import { api } from '../lib/api';
import { dateTime, money, percent } from '../lib/format';

type Period = 'thisMonth' | 'lastMonth' | 'last3Months';

function rangeFor(p: Period) {
  const now = new Date();
  const thisMonth = startOfMonth(now);
  if (p === 'lastMonth') return { from: addMonths(thisMonth, -1), to: thisMonth };
  if (p === 'last3Months') return { from: addMonths(thisMonth, -2), to: addMonths(thisMonth, 1) };
  return { from: thisMonth, to: addMonths(thisMonth, 1) };
}

const BRAND = '#0f766e';
const STATUS_FILL: Record<string, string> = {
  scheduled: '#0ea5e9',
  confirmed: '#10b981',
  completed: '#64748b',
  cancelled: '#f43f5e',
  no_show: '#f59e0b',
};

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card">
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

export function DashboardPage() {
  const { t, i18n } = useTranslation();
  const [period, setPeriod] = useState<Period>('thisMonth');
  const range = useMemo(() => rangeFor(period), [period]);

  const { data, isLoading } = useQuery({
    queryKey: ['dashboard', period],
    queryFn: () =>
      api<DashboardDto>(
        `/metrics/dashboard?from=${encodeURIComponent(range.from.toISOString())}&to=${encodeURIComponent(range.to.toISOString())}`,
      ),
  });

  const intl = i18n.language.startsWith('en') ? 'en-US' : 'es-MX';
  const monthFmt = new Intl.DateTimeFormat(intl, { month: 'short' });
  const weekdayFmt = new Intl.DateTimeFormat(intl, { weekday: 'short' });
  // 2024-01-01 was a Monday: ISO weekday n -> Jan n, 2024
  const weekdayName = (n: number) => weekdayFmt.format(new Date(2024, 0, n));

  if (isLoading || !data) return <Loading />;
  const k = data.kpis;
  const delta = k.revenuePrevCents > 0 ? (k.revenueCents - k.revenuePrevCents) / k.revenuePrevCents : null;

  const monthly = data.revenueByMonth.map((m) => ({
    label: monthFmt.format(new Date(`${m.month}-15T12:00:00`)),
    revenue: m.revenueCents / 100,
  }));
  const weekdays = [1, 2, 3, 4, 5, 6, 7].map((d) => ({
    label: weekdayName(d),
    count: data.appointmentsByWeekday.find((w) => w.weekday === d)?.count ?? 0,
  }));
  const statuses = data.appointmentsByStatus
    .map((s) => ({ status: s.status, label: t(`status.${s.status}`), count: s.count }))
    .sort((a, b) => b.count - a.count);

  return (
    <>
      <PageHeader
        title={t('dashboard.title')}
        actions={
          <>
          <Link to="/reports" className="btn-secondary">{t('dashboard.fullReports')}</Link>
          <select className="input w-auto" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {(['thisMonth', 'lastMonth', 'last3Months'] as const).map((p) => (
              <option key={p} value={p}>{t(`dashboard.${p}`)}</option>
            ))}
          </select>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi
          label={t('dashboard.revenue')}
          value={money(k.revenueCents)}
          sub={delta === null ? undefined : `${delta >= 0 ? '▲' : '▼'} ${percent(Math.abs(delta))} ${t('dashboard.vsPrev')}`}
        />
        <Kpi label={t('dashboard.appointments')} value={String(k.appointments)} sub={`${k.completed} ${t('dashboard.completed')}`} />
        <Kpi
          label={t('dashboard.newCustomers')}
          value={String(k.newCustomers)}
          sub={`${k.activeCustomers} ${t('dashboard.activeCustomers')}`}
        />
        <Kpi label={t('dashboard.noShowRate')} value={percent(k.noShowRate)} />
        <Kpi label={t('dashboard.avgTicket')} value={money(k.avgTicketCents)} />
        <Kpi
          label={t('dashboard.avgFrequency')}
          value={k.avgDaysBetweenVisits == null ? t('common.none') : t('dashboard.days', { count: k.avgDaysBetweenVisits })}
        />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-4 font-semibold">{t('dashboard.revenueByMonth')}</h2>
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={monthly} margin={{ left: 8, right: 8 }}>
                <CartesianGrid vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis tickLine={false} axisLine={false} fontSize={12} width={64} tickFormatter={(v: number) => money(v * 100)} />
                <Tooltip formatter={(v) => money(Number(v) * 100)} cursor={{ fill: '#f1f5f9' }} />
                <Bar dataKey="revenue" name={t('dashboard.revenue')} fill={BRAND} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="card">
          <h2 className="mb-4 font-semibold">{t('dashboard.byWeekday')}</h2>
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={weekdays}>
                <CartesianGrid vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={12} />
                <YAxis allowDecimals={false} tickLine={false} axisLine={false} fontSize={12} width={32} />
                <Tooltip cursor={{ fill: '#f1f5f9' }} />
                <Bar dataKey="count" name={t('dashboard.appointments')} fill={BRAND} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="card">
          <h2 className="mb-4 font-semibold">{t('dashboard.byStatus')}</h2>
          {statuses.length === 0 ? (
            <p className="text-sm text-slate-500">{t('dashboard.noData')}</p>
          ) : (
            <div className="h-56">
              <ResponsiveContainer>
                <BarChart data={statuses} layout="vertical" margin={{ left: 16 }}>
                  <XAxis type="number" allowDecimals={false} hide />
                  <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} fontSize={12} width={96} />
                  <Tooltip cursor={{ fill: '#f1f5f9' }} />
                  <Bar dataKey="count" name={t('dashboard.appointments')} radius={[0, 4, 4, 0]} label={{ position: 'right', fontSize: 12 }}>
                    {statuses.map((s) => (
                      <Cell key={s.status} fill={STATUS_FILL[s.status]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        <section className="card">
          <h2 className="mb-4 font-semibold">{t('dashboard.topCustomers')}</h2>
          {data.topCustomers.length === 0 ? (
            <p className="text-sm text-slate-500">{t('dashboard.noData')}</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.topCustomers.map((c) => (
                <li key={c.id} className="flex items-center justify-between py-2">
                  <Link to={`/customers/${c.id}`} className="font-medium text-slate-800 hover:text-brand-700">{c.name}</Link>
                  <div className="text-right">
                    <div className="font-medium">{money(c.totalSpentCents)}</div>
                    <div className="text-xs text-slate-500">{t('dashboard.visits', { count: c.visits })}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data.topServices.length > 0 && (
            <>
              <h2 className="mb-2 mt-6 font-semibold">{t('dashboard.topServices')}</h2>
              <ul className="divide-y divide-slate-100 text-sm">
                {data.topServices.map((s) => (
                  <li key={s.id} className="flex justify-between py-2">
                    <span>{s.name}</span>
                    <span className="text-slate-600">{s.count} · {money(s.revenueCents)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      <section className="card mt-6">
        <h2 className="mb-4 font-semibold">{t('dashboard.upcoming')}</h2>
        {data.upcoming.length === 0 ? (
          <p className="text-sm text-slate-500">{t('dashboard.noUpcoming')}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {data.upcoming.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div>
                  <div className="font-medium">{a.customerName}</div>
                  <div className="text-sm text-slate-500">{a.serviceName}</div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm text-slate-600">{dateTime(a.startsAt)}</span>
                  <StatusBadge status={a.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
