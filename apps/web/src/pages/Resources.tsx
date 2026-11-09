import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { kindConfig, RESOURCE_COLORS, type ResourceDto, type SessionUser } from '@agenda/shared';
import { Empty, ErrorText, Loading, Modal, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAccess, useAuth } from '../lib/auth';
import { money, toCents } from '../lib/format';
import { LocationSelect } from '../components/Locations';
import { useMyLocations, useResources, useServices } from '../lib/queries';

/**
 * Whatever gets booked — team members, instructors, courts, rooms, tables — managed the same way
 * for every kind of business. Only the wording changes (i18n `kinds.<kind>.*`).
 */
export function ResourcesPage() {
  const { t } = useTranslation();
  const { tenant } = useAuth();
  const kind = tenant?.kind ?? 'appointments';
  const { manager, locationId: ownLocation } = useAccess();
  const locs = useMyLocations(ownLocation);
  const canEdit = (r: { locationId: string }) => manager && (!ownLocation || r.locationId === ownLocation);
  const resources = useResources();
  const services = useServices();
  const [editing, setEditing] = useState<ResourceDto | 'new' | null>(null);
  const list = resources.data ?? [];
  const svcName = new Map((services.data ?? []).map((s) => [s.id, s.name]));
  const pickServices = !kindConfig(kind).partySize && !kindConfig(kind).durations;

  const summary = (r: ResourceDto) =>
    [
      !r.active && t('services.inactive'),
      r.capacity != null && t('resources.capacityN', { count: r.capacity }),
      r.pricePerHourCents != null && t('resources.perHour', { price: money(r.pricePerHourCents) }),
      pickServices && (r.serviceIds.length ? r.serviceIds.map((id) => svcName.get(id)).filter(Boolean).join(', ') : t('resources.allServices')),
      r.description,
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <>
      <PageHeader
        title={t(`kinds.${kind}.resources`)}
        actions={manager && <button className="btn-primary" onClick={() => setEditing('new')}>{t(`kinds.${kind}.addResource`)}</button>}
      />
      <p className="-mt-4 mb-4 max-w-2xl text-sm text-slate-500">{t(`kinds.${kind}.resourcesHelp`)}</p>
      {resources.isLoading ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty>{t(`kinds.${kind}.resourcesEmpty`)}</Empty>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((r) => (
            <button
              key={r.id}
              data-testid="resource-card"
              disabled={!canEdit(r)}
              onClick={() => setEditing(r)}
              className={`card !p-4 text-left ${r.active ? '' : 'opacity-60'} ${canEdit(r) ? 'hover:border-brand-500' : ''}`}
            >
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white" style={{ background: r.color }}>
                  {r.name.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0">
                  <div className="truncate font-semibold">{r.name}</div>
                  {locs.anyMulti && <div className="truncate text-xs text-brand-700">⌂ {locs.byId.get(r.locationId)?.name}</div>}
                  <div className="truncate text-xs text-slate-500">{summary(r)}</div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {editing && <ResourceModal resource={editing === 'new' ? null : editing} pickServices={pickServices} onClose={() => setEditing(null)} />}
    </>
  );
}

function ResourceModal({ resource, pickServices, onClose }: { resource: ResourceDto | null; pickServices: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { tenant } = useAuth();
  const kind = tenant?.kind ?? 'appointments';
  const { locationId: ownLocation } = useAccess();
  const locs = useMyLocations(ownLocation);
  const qc = useQueryClient();
  const services = useServices();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<SessionUser[]>('/users') });
  const [form, setForm] = useState({
    name: resource?.name ?? '',
    color: resource?.color ?? RESOURCE_COLORS[Math.floor(Math.random() * RESOURCE_COLORS.length)]!,
    active: resource?.active ?? true,
    serviceIds: resource?.serviceIds ?? [],
    userId: resource?.userId ?? '',
    locationId: resource?.locationId ?? ownLocation ?? '',
    capacity: resource?.capacity != null ? String(resource.capacity) : '',
    price: resource?.pricePerHourCents != null ? String(resource.pricePerHourCents / 100) : '',
    description: resource?.description ?? '',
  });
  const [info, setInfo] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['resources'] });
    void qc.invalidateQueries({ queryKey: ['appointments'] });
    void qc.invalidateQueries({ queryKey: ['class-sessions'] });
  };
  const save = useMutation({
    mutationFn: () =>
      api<ResourceDto>(resource ? `/resources/${resource.id}` : '/resources', {
        method: resource ? 'PUT' : 'POST',
        body: {
          name: form.name,
          color: form.color,
          active: form.active,
          serviceIds: form.serviceIds,
          userId: form.userId || null,
          locationId: form.locationId || undefined,
          capacity: form.capacity ? Number(form.capacity) : null,
          pricePerHourCents: form.price === '' ? null : toCents(form.price),
          description: form.description.trim() || null,
        },
      }),
    onSuccess: () => {
      refresh();
      onClose();
    },
  });
  const remove = useMutation({
    mutationFn: () => api<{ deactivated?: boolean } | undefined>(`/resources/${resource!.id}`, { method: 'DELETE' }),
    onSuccess: (r) => {
      refresh();
      if (r?.deactivated) setInfo(t('resources.deactivated'));
      else onClose();
    },
  });
  const active = (services.data ?? []).filter((s) => s.active);
  const toggle = (id: string) =>
    setForm((f) => ({ ...f, serviceIds: f.serviceIds.includes(id) ? f.serviceIds.filter((x) => x !== id) : [...f.serviceIds, id] }));

  return (
    <Modal open title={resource ? t(`kinds.${kind}.editResource`) : t(`kinds.${kind}.addResource`)} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div>
          <label className="label" htmlFor="res-name">{t('resources.name')}</label>
          <input id="res-name" required maxLength={80} className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        {locs.multi && (
          <div>
            <label className="label" htmlFor="res-loc">{t('locations.location')}</label>
            <LocationSelect id="res-loc" value={form.locationId || locs.list[0]!.id} onChange={(v) => setForm({ ...form, locationId: v })} list={locs.list} />
          </div>
        )}
        <div>
          <div className="label">{t('resources.color')}</div>
          <div className="flex flex-wrap gap-2" role="group" aria-label={t('resources.color')}>
            {RESOURCE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={form.color === c}
                onClick={() => setForm({ ...form, color: c })}
                className={`h-8 w-8 rounded-full border-2 ${form.color === c ? 'border-slate-900' : 'border-white'} shadow`}
                style={{ background: c }}
              />
            ))}
          </div>
        </div>
        {pickServices && active.length > 0 && (
          <div>
            <div className="label">{t('resources.services')}</div>
            <p className="mb-2 text-xs text-slate-500">{t('resources.servicesHelp')}</p>
            <div className="flex flex-wrap gap-2">
              {active.map((s) => {
                const on = form.serviceIds.includes(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => toggle(s.id)}
                    aria-pressed={on}
                    className={`rounded-full border px-3 py-1 text-sm ${on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 text-slate-600'}`}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="res-cap">{t('resources.capacity')}</label>
            <input id="res-cap" type="number" min={1} max={500} className="input" placeholder={t('common.optional')} value={form.capacity} required={kindConfig(kind).partySize} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
            <p className="mt-1 text-xs text-slate-500">{t('resources.capacityHelp')}</p>
          </div>
          <div>
            <label className="label" htmlFor="res-price">{t('resources.pricePerHour')}</label>
            <input id="res-price" type="number" min={0} step="0.01" className="input" placeholder={t('common.optional')} value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
            <p className="mt-1 text-xs text-slate-500">{t('resources.pricePerHourHelp')}</p>
          </div>
        </div>
        <div>
          <label className="label" htmlFor="res-desc">{t('resources.description')}</label>
          <input id="res-desc" maxLength={300} className="input" placeholder={t('common.optional')} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div>
          <label className="label" htmlFor="res-login">{t('resources.login')}</label>
          <select id="res-login" className="input" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
            <option value="">{t('resources.noLogin')}</option>
            {(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name} · {u.email}</option>)}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
          {t('resources.activeLabel')}
        </label>
        {info && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{info}</p>}
        <ErrorText error={save.error ?? remove.error} />
        <div className="flex items-center justify-between">
          {resource ? (
            <button type="button" className="text-sm text-rose-700 hover:underline" onClick={() => window.confirm(t('resources.deleteConfirm')) && remove.mutate()}>
              {t('common.delete')}
            </button>
          ) : <span />}
          <div className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
            <button className="btn-primary" disabled={save.isPending}>{t('common.save')}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
