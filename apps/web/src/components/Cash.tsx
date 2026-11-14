import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, startOfMonth } from 'date-fns';
import { CASH_METHODS, type CashClosingDto, type CashSummaryDto, type CommissionReportDto, type ResourceDto } from '@agenda/shared';
import { api } from '../lib/api';
import { useAccess } from '../lib/auth';
import { dateOnly, dateTime, money, toCents } from '../lib/format';
import { useMyLocations, useResources, useServices } from '../lib/queries';
import { ErrorText, Loading } from './ui';
import { DataTable, useColumns } from './Columns';
import { UpgradeNote, useFeature } from './Sales';

const ymd = (d: Date) => format(d, 'yyyy-MM-dd');

/** CSV with ; separators (opens well in Excel en español) and a BOM for accents. */
function downloadCsv(name: string, rows: (string | number)[][]) {
  const csv = '﻿' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Commissions: report by date range (CSV) and, for managers, each person's percentages. */
export function CommissionsTab() {
  const { t } = useTranslation();
  const { manager } = useAccess();
  const enabled = useFeature('cash');
  const [from, setFrom] = useState(ymd(startOfMonth(new Date())));
  const [to, setTo] = useState(ymd(new Date()));
  const rep = useQuery({
    queryKey: ['commissions', from, to],
    queryFn: () => api<CommissionReportDto>(`/reports/commissions?from=${from}&to=${to}`),
    enabled,
  });
  const [editing, setEditing] = useState(false);
  const d = rep.data;
  const total = (k: 'soldCents' | 'commissionCents') => (d?.rows ?? []).reduce((a, r) => a + r[k], 0);
  type Row = CommissionReportDto['rows'][number];
  const { cols, menu } = useColumns<Row>('commissions', [
    { key: 'person', label: t('cash.person'), required: true, className: 'font-medium', td: (r) => r.resourceName },
    { key: 'completed', label: t('cash.completed'), className: 'text-right', td: (r) => r.completed },
    { key: 'sold', label: t('cash.sold'), className: 'text-right', td: (r) => money(r.soldCents) },
    { key: 'commission', label: t('cash.commission'), className: 'text-right font-semibold text-emerald-800', td: (r) => money(r.commissionCents) },
  ]);
  const foot: Record<string, ReactNode> = { person: t('cash.total'), sold: money(total('soldCents')), commission: money(total('commissionCents')) };
  if (!enabled) return <UpgradeNote feature="cash" />;
  return (
    <div className="space-y-4" data-testid="commissions-tab">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="label" htmlFor="cm-from">{t('cash.from')}</label>
          <input id="cm-from" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="cm-to">{t('cash.to')}</label>
          <input id="cm-to" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <button
          type="button"
          className="btn-secondary"
          disabled={!d?.lines.length}
          onClick={() =>
            downloadCsv(`comisiones_${from}_${to}.csv`, [
              [t('cash.person'), t('cash.date'), t('agenda.service'), t('agenda.customer'), t('cash.sold'), '%', t('cash.commission')],
              ...d!.lines.map((l) => [l.resourceName, dateTime(l.startsAt), l.serviceName, l.customerName, (l.priceCents / 100).toFixed(2), l.pct, (l.commissionCents / 100).toFixed(2)]),
            ])
          }
        >
          ⬇ CSV
        </button>
        {manager && <button type="button" className="btn-secondary" onClick={() => setEditing((e) => !e)}>{t('cash.setRates')}</button>}
        <span className="ml-auto">{menu}</span>
      </div>
      {editing && <CommissionRates />}
      {rep.isLoading ? <Loading /> : (
        d?.rows.length === 0 ? (
          <p className="rounded-xl border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500">{t('cash.noCompleted')}</p>
        ) : (
          <DataTable cols={cols} rows={d?.rows ?? []} rowKey={(r) => r.resourceId} foot={(d?.rows.length ?? 0) > 1 ? foot : undefined} />
        )
      )}
      <p className="text-xs text-slate-500">{t('cash.commissionHelp')}</p>
    </div>
  );
}

function CommissionRates() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const resources = useResources();
  const services = useServices();
  const [open, setOpen] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (r: { id: string; commissionPct: number | null; commissionByService: Record<string, number> }) =>
      api(`/resources/${r.id}/commission`, { method: 'PUT', body: { commissionPct: r.commissionPct, commissionByService: r.commissionByService } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['resources'] });
      void qc.invalidateQueries({ queryKey: ['commissions'] });
    },
  });
  const active = (resources.data ?? []).filter((r) => r.active);
  return (
    <div className="card space-y-2" data-testid="commission-rates">
      <p className="text-sm text-slate-600">{t('cash.ratesHelp')}</p>
      {active.map((r: ResourceDto) => (
        <div key={r.id} className="rounded-lg border border-slate-200 p-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-[8rem] font-medium">{r.name}</span>
            <input
              type="number" min={0} max={100} step="0.5" className="input !w-24 !py-1" aria-label={t('cash.generalPct', { name: r.name })}
              defaultValue={r.commissionPct ?? ''} placeholder="0"
              onBlur={(e) => save.mutate({ id: r.id, commissionPct: e.target.value === '' ? null : Number(e.target.value), commissionByService: r.commissionByService })}
            />
            <span className="text-slate-500">%</span>
            <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => setOpen(open === r.id ? null : r.id)}>
              {t('cash.perService', { count: Object.keys(r.commissionByService).length })}
            </button>
          </div>
          {open === r.id && (
            <div className="mt-2 grid gap-1 sm:grid-cols-2">
              {(services.data ?? []).filter((s) => s.active).map((s) => (
                <label key={s.id} className="flex items-center justify-between gap-2 text-xs">
                  {s.name}
                  <input
                    type="number" min={0} max={100} step="0.5" className="input !w-20 !py-1" placeholder={String(r.commissionPct ?? 0)}
                    defaultValue={r.commissionByService[s.id] ?? ''}
                    onBlur={(e) => {
                      const next = { ...r.commissionByService };
                      if (e.target.value === '') delete next[s.id];
                      else next[s.id] = Number(e.target.value);
                      save.mutate({ id: r.id, commissionPct: r.commissionPct, commissionByService: next });
                    }}
                  />
                </label>
              ))}
            </div>
          )}
        </div>
      ))}
      <ErrorText error={save.error} />
    </div>
  );
}

/** Daily cash closing per location: what came in by method, cash expected vs counted, history. */
export function CashTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { locationId: own } = useAccess();
  const enabled = useFeature('cash');
  const locs = useMyLocations(own);
  const [day, setDay] = useState(ymd(new Date()));
  const [loc, setLoc] = useState(own ?? '');
  const locationId = loc || locs.list[0]?.id || '';
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const sum = useQuery({
    queryKey: ['cash-summary', day, locationId],
    queryFn: () => api<CashSummaryDto>(`/cash/summary?day=${day}${locationId ? `&locationId=${locationId}` : ''}`),
    enabled: enabled && Boolean(locationId),
  });
  const history = useQuery({ queryKey: ['cash-closings'], queryFn: () => api<CashClosingDto[]>('/cash/closings'), enabled });
  const close = useMutation({
    mutationFn: () => api('/cash/closings', { method: 'POST', body: { day, locationId, countedCashCents: toCents(counted || '0'), notes: notes || null } }),
    onSuccess: () => {
      setCounted('');
      setNotes('');
      void qc.invalidateQueries({ queryKey: ['cash-closings'] });
    },
  });
  if (!enabled) return <UpgradeNote feature="cash" />;
  const s = sum.data;
  const diff = counted !== '' && s ? toCents(counted) - s.expectedCashCents : null;
  return (
    <div className="grid items-stretch gap-6 lg:grid-cols-2" data-testid="cash-tab">
      <section className="card space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label" htmlFor="cash-day">{t('cash.day')}</label>
            <input id="cash-day" type="date" className="input" value={day} onChange={(e) => setDay(e.target.value)} />
          </div>
          {locs.multi && !own && (
            <div>
              <label className="label" htmlFor="cash-loc">{t('locations.location')}</label>
              <select id="cash-loc" className="input" value={locationId} onChange={(e) => setLoc(e.target.value)}>
                {locs.list.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          )}
        </div>
        {s && (
          <>
            <ul className="divide-y divide-slate-100 text-sm">
              {CASH_METHODS.filter((m) => m !== 'card' || s.byMethod[m]).map((m) => (
                <li key={m} className="flex justify-between py-1.5"><span>{t(`methods.${m}`)}</span><span className="font-medium">{money(s.byMethod[m] ?? 0)}</span></li>
              ))}
              <li className="flex justify-between py-1.5 font-semibold"><span>{t('cash.total')}</span><span>{money(s.totalCents)}</span></li>
            </ul>
            {s.salesCents > 0 && (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
                {t('cash.salesIncluded')}: {t('sales.kind.package')} {money(s.salesByKind.packages)} · {t('sales.kind.membership')} {money(s.salesByKind.memberships)} · {t('sales.giftCards')} {money(s.salesByKind.giftCards)} · {t('pos.products')} {money(s.salesByKind.products)}
              </p>
            )}
            <form className="space-y-2 border-t border-slate-100 pt-3" onSubmit={(e) => { e.preventDefault(); close.mutate(); }}>
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <div className="label">{t('cash.expected')}</div>
                  <div className="py-2 text-lg font-semibold">{money(s.expectedCashCents)}</div>
                </div>
                <div>
                  <label className="label" htmlFor="cash-counted">{t('cash.counted')}</label>
                  <input id="cash-counted" required type="number" min={0} step="0.01" className="input !w-36" value={counted} onChange={(e) => setCounted(e.target.value)} />
                </div>
                {diff != null && (
                  <div>
                    <div className="label">{t('cash.difference')}</div>
                    <div className={`py-2 text-lg font-semibold ${diff === 0 ? 'text-emerald-700' : 'text-rose-700'}`} data-testid="cash-diff">{diff > 0 ? '+' : ''}{money(diff)}</div>
                  </div>
                )}
              </div>
              <input className="input" placeholder={t('cash.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} />
              <ErrorText error={close.error} />
              <button className="btn-primary" disabled={close.isPending}>{t('cash.close')}</button>
            </form>
          </>
        )}
        <ErrorText error={sum.error} />
      </section>
      <section className="card">
        <h2 className="mb-2 font-semibold">{t('cash.history')}</h2>
        <ul className="divide-y divide-slate-100 text-sm" data-testid="cash-history">
          {(history.data ?? []).map((h) => (
            <li key={h.id} className="py-2">
              <div className="flex justify-between">
                <span className="font-medium">{dateOnly(h.day)}{locs.multi ? ` · ${h.locationName}` : ''}</span>
                <span className={h.differenceCents === 0 ? 'text-emerald-700' : 'font-semibold text-rose-700'}>{h.differenceCents > 0 ? '+' : ''}{money(h.differenceCents)}</span>
              </div>
              <div className="text-xs text-slate-500">
                {t('cash.expected')} {money(h.expectedCashCents)} · {t('cash.counted')} {money(h.countedCashCents)} · {h.closedByName}
                {h.notes && ` · ${h.notes}`}
              </div>
            </li>
          ))}
          {history.data?.length === 0 && <li className="py-2 text-slate-500">{t('cash.noHistory')}</li>}
        </ul>
      </section>
    </div>
  );
}
