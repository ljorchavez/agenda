import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_BUSINESS_HOURS, type BusinessHours, type LocationDto } from '@agenda/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLocations } from '../lib/queries';
import { MapView, TYPE_COLORS } from './MapView';
import { MX_STATES } from './PublicProfile';
import { ErrorText, Modal } from './ui';

type Form = {
  name: string;
  phone: string;
  address: string;
  neighborhood: string;
  city: string;
  state: string;
  lat: number | null;
  lng: number | null;
  ownHours: boolean;
  hours: BusinessHours;
  active: boolean;
};

/**
 * Sucursales. Each one has its own team/tables/spaces, hours and booking page choice.
 * Pricing: the plan includes PLAN_INCLUDED_LOCATIONS; every extra active location is an add-on.
 */
export function LocationsSection({ editable }: { editable: boolean }) {
  const { t } = useTranslation();
  const q = useLocations();
  const [editing, setEditing] = useState<LocationDto | 'new' | null>(null);
  const plan = q.data?.plan;
  return (
    <section className="card mt-6" id="sucursales">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{t('locations.title')}</h2>
        {editable && <button className="btn-secondary" onClick={() => setEditing('new')}>{t('locations.add')}</button>}
      </div>
      <p className="mb-3 text-sm text-slate-500">{t('locations.help')}</p>
      {plan && (
        <div className="mb-3 rounded-lg bg-slate-50 p-3 text-sm text-slate-700" data-testid="plan">
          {t('locations.plan', { included: plan.includedLocations, active: plan.activeLocations })}
          {plan.extraLocations > 0 && <span className="font-medium"> · {t('locations.extra', { count: plan.extraLocations })}</span>}
        </div>
      )}
      <ul className="divide-y divide-slate-100 text-sm">
        {(q.data?.locations ?? []).map((l) => (
          <li key={l.id} className={`flex flex-wrap items-center justify-between gap-2 py-2.5 ${l.active ? '' : 'opacity-60'}`}>
            <span className="min-w-0">
              <span className="font-medium text-slate-800">{l.name}</span>
              {l.isPrimary && <span className="ml-2 rounded-full bg-brand-50 px-2 py-0.5 text-xs text-brand-800">{t('locations.primary')}</span>}
              {!l.active && <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs">{t('services.inactive')}</span>}
              <span className="block truncate text-slate-500">
                {l.isPrimary && !l.address ? t('locations.usesProfile') : [l.address, l.neighborhood, l.city].filter(Boolean).join(', ') || '—'}
                {' · '}
                {l.hours ? `${l.hours.open}–${l.hours.close}` : t('locations.businessHours')}
              </span>
            </span>
            {editable && (
              <button className="text-sm font-medium text-brand-700 hover:underline" onClick={() => setEditing(l)} aria-label={`${t('common.edit')} ${l.name}`}>
                {t('common.edit')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {editing && <LocationModal target={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

function LocationModal({ target, onClose }: { target: LocationDto | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const { tenant } = useAuth();
  const qc = useQueryClient();
  const [f, setF] = useState<Form>({
    name: target?.name ?? '',
    phone: target?.phone ?? '',
    address: target?.address ?? '',
    neighborhood: target?.neighborhood ?? '',
    city: target?.city ?? '',
    state: target?.state ?? '',
    lat: target?.lat ?? null,
    lng: target?.lng ?? null,
    ownHours: Boolean(target?.hours),
    hours: target?.hours ?? tenant?.settings.hours ?? DEFAULT_BUSINESS_HOURS,
    active: target?.active ?? true,
  });
  const set = (patch: Partial<Form>) => setF((x) => ({ ...x, ...patch }));
  const primary = Boolean(target?.isPrimary);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name,
        phone: f.phone || null,
        address: f.address || null,
        neighborhood: f.neighborhood || null,
        city: f.city || null,
        state: f.state || null,
        lat: f.lat,
        lng: f.lng,
        hours: f.ownHours ? f.hours : null,
        active: f.active,
      };
      return target ? api(`/locations/${target.id}`, { method: 'PUT', body }) : api('/locations', { method: 'POST', body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['locations'] });
      onClose();
    },
  });
  const findOnMap = async () => {
    const q = [f.address, f.neighborhood, f.city, f.state, 'México'].filter(Boolean).join(', ');
    if (!q) return;
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=mx&q=${encodeURIComponent(q)}`);
      const [hit] = (await res.json()) as { lat: string; lon: string }[];
      if (hit) set({ lat: Number(hit.lat), lng: Number(hit.lon) });
    } catch {
      /* the pin can still be placed by hand */
    }
  };
  const markers = useMemo(
    () => (f.lat != null && f.lng != null ? [{ id: 'loc', lat: f.lat, lng: f.lng, color: TYPE_COLORS[tenant!.businessType] ?? '#0f766e', title: f.name }] : []),
    [f.lat, f.lng, f.name, tenant],
  );
  const intl = i18n.language.startsWith('en') ? 'en-US' : 'es-MX';
  const dayName = (n: number) => new Intl.DateTimeFormat(intl, { weekday: 'short' }).format(new Date(2024, 0, n));
  const h = f.hours;
  const willBeExtra = !target;
  return (
    <Modal open wide title={target ? t('locations.edit') : t('locations.add')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        {willBeExtra && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{t('locations.extraNotice')}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label" htmlFor="loc-name">{t('locations.name')}</label>
            <input id="loc-name" required minLength={2} className="input" placeholder="Polanco" value={f.name} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div>
            <label className="label" htmlFor="loc-phone">{t('auth.phone')}</label>
            <input id="loc-phone" type="tel" className="input" value={f.phone} onChange={(e) => set({ phone: e.target.value })} />
          </div>
        </div>
        {primary && <p className="text-xs text-slate-500">{t('locations.primaryAddressHelp')}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label" htmlFor="loc-address">{t('profile.address')}</label>
            <input id="loc-address" className="input" value={f.address} onChange={(e) => set({ address: e.target.value })} />
          </div>
          <div>
            <label className="label">{t('profile.neighborhood')}</label>
            <input className="input" value={f.neighborhood} onChange={(e) => set({ neighborhood: e.target.value })} />
          </div>
          <div>
            <label className="label">{t('profile.city')}</label>
            <input className="input" value={f.city} onChange={(e) => set({ city: e.target.value })} />
          </div>
          <div>
            <label className="label">{t('profile.state')}</label>
            <select className="input" value={f.state} onChange={(e) => set({ state: e.target.value })}>
              <option value="">—</option>
              {MX_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="flex items-end">
            <button type="button" className="btn-secondary w-full" onClick={findOnMap}>{t('profile.findAddress')}</button>
          </div>
        </div>
        <MapView markers={markers} onPick={(lat, lng) => set({ lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) })} fitKey={`${f.lat},${f.lng}`} className="h-48" />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.ownHours} onChange={(e) => set({ ownHours: e.target.checked })} />
          {t('locations.ownHours')}
        </label>
        {f.ownHours && (
          <div className="space-y-2 rounded-lg border border-slate-200 p-3">
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => {
                const on = h.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() => {
                      const days = on ? h.days.filter((x) => x !== d) : [...h.days, d].sort();
                      if (days.length) set({ hours: { ...h, days } });
                    }}
                    className={`rounded-lg border px-2.5 py-1 text-sm capitalize ${on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 text-slate-500'}`}
                  >
                    {dayName(d)}
                  </button>
                );
              })}
            </div>
            <div className="grid grid-cols-3 gap-2">
              <input type="time" className="input" aria-label={t('settings.open')} value={h.open} onChange={(e) => set({ hours: { ...h, open: e.target.value } })} />
              <input type="time" className="input" aria-label={t('settings.close')} value={h.close} onChange={(e) => set({ hours: { ...h, close: e.target.value } })} />
              <select className="input" aria-label={t('settings.slotMinutes')} value={h.slotMinutes} onChange={(e) => set({ hours: { ...h, slotMinutes: Number(e.target.value) } })}>
                {[15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m} min</option>)}
              </select>
            </div>
          </div>
        )}
        {!primary && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={f.active} onChange={(e) => set({ active: e.target.checked })} />
            {t('locations.active')}
          </label>
        )}
        <ErrorText error={save.error} ns="locations" />
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn-primary" disabled={save.isPending}>{t('common.save')}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Small "Sucursal" picker used by the agenda, team, tables, spaces, classes and reports. */
export function LocationSelect({
  value,
  onChange,
  list,
  allLabel,
  className = 'input',
  id,
}: {
  value: string;
  onChange: (id: string) => void;
  list: LocationDto[];
  allLabel?: string;
  className?: string;
  id?: string;
}) {
  const { t } = useTranslation();
  return (
    <select id={id} aria-label={t('locations.location')} className={className} value={value} onChange={(e) => onChange(e.target.value)}>
      {allLabel && <option value="">{allLabel}</option>}
      {list.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
    </select>
  );
}
