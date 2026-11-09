import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TableDto } from '@agenda/shared';
import { Empty, ErrorText, Loading, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAccess, useAuth } from '../lib/auth';
import { LocationSelect } from '../components/Locations';
import { useMyLocations } from '../lib/queries';

/** Restaurant tables: name, seats and area. Online reservations are assigned to the smallest free table that fits. */
export function TablesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isOwner = user?.role === 'owner' || user?.role === 'admin';
  // Each location has its own; managers limited to a location only see theirs.
  const { locationId: ownLocation } = useAccess();
  const locs = useMyLocations(ownLocation);
  const [loc, setLoc] = useState('');
  const currentLoc = loc || ownLocation || locs.list[0]?.id || '';
  const tables = useQuery({ queryKey: ['tables'], queryFn: () => api<TableDto[]>('/tables') });
  const [form, setForm] = useState({ name: '', seats: '4', area: '' });
  const [info, setInfo] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['tables'] });

  const create = useMutation({
    mutationFn: () => api<TableDto>('/tables', { method: 'POST', body: { name: form.name, seats: Number(form.seats), area: form.area || null, active: true, locationId: currentLoc || undefined } }),
    onSuccess: () => {
      setForm({ name: '', seats: form.seats, area: form.area });
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: (x: TableDto) => api<TableDto>(`/tables/${x.id}`, { method: 'PUT', body: { name: x.name, seats: x.seats, area: x.area, active: x.active, locationId: x.locationId } }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<{ deactivated?: boolean } | undefined>(`/tables/${id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      setInfo(r?.deactivated ? t('tables.deactivated') : '');
      refresh();
    },
  });

  const list = (tables.data ?? []).filter((x) => !locs.anyMulti || x.locationId === currentLoc);
  const seats = list.filter((x) => x.active).reduce((a, x) => a + x.seats, 0);

  return (
    <>
      <PageHeader title={t('tables.title')} />
      <p className="-mt-4 mb-4 text-sm text-slate-500">{t('tables.help')}</p>
      {locs.multi && <LocationSelect value={currentLoc} onChange={setLoc} list={locs.list} className="input mb-4 max-w-xs" />}

      {isOwner && (
        <form
          className="card mb-6 grid gap-2 sm:grid-cols-[1fr_8rem_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <input required className="input" placeholder={t('tables.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input required type="number" min={1} max={50} className="input" aria-label={t('tables.seats')} value={form.seats} onChange={(e) => setForm({ ...form, seats: e.target.value })} />
          <input className="input" placeholder={`${t('tables.area')} (${t('common.optional')})`} value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} />
          <button className="btn-primary" disabled={create.isPending}>{t('tables.add')}</button>
          <div className="sm:col-span-4"><ErrorText error={create.error} /></div>
        </form>
      )}

      {info && <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{info}</p>}
      {tables.isLoading ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty>{t('tables.empty')}</Empty>
      ) : (
        <>
          <p className="mb-2 text-sm text-slate-600">{t('tables.summary', { tables: list.filter((x) => x.active).length, seats })}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {list.map((x) => (
              <div key={x.id} className={`card !p-4 ${x.active ? '' : 'opacity-60'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold">{x.name}</div>
                    <div className="text-sm text-slate-500">{t('tables.seatsN', { count: x.seats })}{x.area ? ` · ${x.area}` : ''}</div>
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${x.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
                    {x.active ? t('services.active') : t('services.inactive')}
                  </span>
                </div>
                {isOwner && (
                  <div className="mt-3 flex flex-wrap gap-3 text-sm">
                    <button className="text-brand-700" onClick={() => update.mutate({ ...x, seats: Math.min(50, x.seats + 1) })}>+1</button>
                    <button className="text-brand-700" disabled={x.seats <= 1} onClick={() => update.mutate({ ...x, seats: Math.max(1, x.seats - 1) })}>−1</button>
                    <button className="text-slate-600" onClick={() => update.mutate({ ...x, active: !x.active })}>
                      {x.active ? t('tables.disable') : t('tables.enable')}
                    </button>
                    <button className="text-rose-700" onClick={() => window.confirm(t('tables.deleteConfirm')) && remove.mutate(x.id)}>{t('common.delete')}</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <ErrorText error={update.error ?? remove.error} />
    </>
  );
}
