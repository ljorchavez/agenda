import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SpaceDto } from '@agenda/shared';
import { Empty, ErrorText, Loading, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAccess, useAuth } from '../lib/auth';
import { LocationSelect } from '../components/Locations';
import { money, toCents } from '../lib/format';
import { useMyLocations, useSpaces } from '../lib/queries';

/** Courts, rooms or studios rented by the hour. Online bookings pick a free one or the one the customer chose. */
export function SpacesPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { user } = useAuth();
  const isOwner = user?.role === 'owner' || user?.role === 'admin';
  // Each location has its own; managers limited to a location only see theirs.
  const { locationId: ownLocation } = useAccess();
  const locs = useMyLocations(ownLocation);
  const [loc, setLoc] = useState('');
  const currentLoc = loc || ownLocation || locs.list[0]?.id || '';
  const spaces = useSpaces();
  const [form, setForm] = useState({ name: '', price: '', description: '' });
  const [editing, setEditing] = useState<{ id: string; name: string; price: string; description: string } | null>(null);
  const [info, setInfo] = useState('');
  const refresh = () => void qc.invalidateQueries({ queryKey: ['spaces'] });

  const create = useMutation({
    mutationFn: () =>
      api<SpaceDto>('/spaces', {
        method: 'POST',
        body: { name: form.name, pricePerHourCents: toCents(form.price || 0), description: form.description || null, active: true, locationId: currentLoc || undefined },
      }),
    onSuccess: () => {
      setForm({ name: '', price: form.price, description: '' });
      refresh();
    },
  });
  const update = useMutation({
    mutationFn: (x: SpaceDto) =>
      api<SpaceDto>(`/spaces/${x.id}`, { method: 'PUT', body: { name: x.name, pricePerHourCents: x.pricePerHourCents, description: x.description, active: x.active, locationId: x.locationId } }),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api<{ deactivated?: boolean } | undefined>(`/spaces/${id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      setInfo(r?.deactivated ? t('spaces.deactivated') : '');
      refresh();
    },
  });

  const list = (spaces.data ?? []).filter((x) => !locs.anyMulti || x.locationId === currentLoc);

  return (
    <>
      <PageHeader title={t('spaces.title')} />
      <p className="-mt-4 mb-4 text-sm text-slate-500">{t('spaces.help')}</p>
      {locs.multi && <LocationSelect value={currentLoc} onChange={setLoc} list={locs.list} className="input mb-4 max-w-xs" />}

      {isOwner && (
        <form
          className="card mb-6 grid gap-2 sm:grid-cols-[1fr_10rem_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <input required className="input" placeholder={t('spaces.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input required type="number" min={0} step="0.01" className="input" placeholder={t('spaces.pricePerHour')} aria-label={t('spaces.pricePerHour')} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
          <input className="input" placeholder={`${t('spaces.description')} (${t('common.optional')})`} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          <button className="btn-primary" disabled={create.isPending}>{t('spaces.add')}</button>
          <div className="sm:col-span-4"><ErrorText error={create.error} /></div>
        </form>
      )}

      {info && <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{info}</p>}
      {spaces.isLoading ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty>{t('spaces.empty')}</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((x) =>
            editing?.id === x.id ? (
              <form
                key={x.id}
                className="card space-y-2 !p-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  update.mutate({ ...x, name: editing.name, pricePerHourCents: toCents(editing.price || 0), description: editing.description || null });
                }}
              >
                <input required className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                <input required type="number" min={0} step="0.01" className="input" aria-label={t('spaces.pricePerHour')} value={editing.price} onChange={(e) => setEditing({ ...editing, price: e.target.value })} />
                <input className="input" placeholder={t('spaces.description')} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
                <div className="flex gap-2">
                  <button className="btn-primary" disabled={update.isPending}>{t('common.save')}</button>
                  <button type="button" className="btn-secondary" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
                </div>
              </form>
            ) : (
              <div key={x.id} className={`card !p-4 ${x.active ? '' : 'opacity-60'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold">{x.name}</div>
                    <div className="text-sm text-slate-600">{t('spaces.perHour', { price: money(x.pricePerHourCents) })}</div>
                    {x.description && <div className="mt-1 text-xs text-slate-500">{x.description}</div>}
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${x.active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
                    {x.active ? t('services.active') : t('services.inactive')}
                  </span>
                </div>
                {isOwner && (
                  <div className="mt-3 flex flex-wrap gap-3 text-sm">
                    <button className="text-brand-700" onClick={() => setEditing({ id: x.id, name: x.name, price: String(x.pricePerHourCents / 100), description: x.description ?? '' })}>
                      {t('common.edit')}
                    </button>
                    <button className="text-slate-600" onClick={() => update.mutate({ ...x, active: !x.active })}>
                      {x.active ? t('tables.disable') : t('tables.enable')}
                    </button>
                    <button className="text-rose-700" onClick={() => window.confirm(t('spaces.deleteConfirm')) && remove.mutate(x.id)}>{t('common.delete')}</button>
                  </div>
                )}
              </div>
            ),
          )}
        </div>
      )}
      <ErrorText error={update.error ?? remove.error} />
    </>
  );
}
