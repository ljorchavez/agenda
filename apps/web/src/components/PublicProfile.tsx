import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useMutation } from '@tanstack/react-query';
import type { TenantDto, TenantProfile } from '@agenda/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { MapView, TYPE_COLORS } from './MapView';
import { ErrorText } from './ui';

export const MX_STATES = [
  'Aguascalientes', 'Baja California', 'Baja California Sur', 'Campeche', 'Chiapas', 'Chihuahua',
  'Ciudad de México', 'Coahuila', 'Colima', 'Durango', 'Estado de México', 'Guanajuato', 'Guerrero',
  'Hidalgo', 'Jalisco', 'Michoacán', 'Morelos', 'Nayarit', 'Nuevo León', 'Oaxaca', 'Puebla', 'Querétaro',
  'Quintana Roo', 'San Luis Potosí', 'Sinaloa', 'Sonora', 'Tabasco', 'Tamaulipas', 'Tlaxcala', 'Veracruz',
  'Yucatán', 'Zacatecas',
];

/** Business public profile: description, address, zone, map pin and directory opt-in. */
export function PublicProfileSection({ disabled }: { disabled: boolean }) {
  const { t } = useTranslation();
  const { tenant, setTenant } = useAuth();
  const [p, setP] = useState<TenantProfile>(tenant!.profile);
  const [saved, setSaved] = useState(false);
  const [finding, setFinding] = useState(false);
  const [findError, setFindError] = useState(false);
  const set = (patch: Partial<TenantProfile>) => {
    setP((x) => ({ ...x, ...patch }));
    setSaved(false);
  };

  const save = useMutation({
    mutationFn: () =>
      api<TenantDto>('/tenant', {
        method: 'PATCH',
        body: {
          profile: {
            ...p,
            description: p.description || null,
            address: p.address || null,
            neighborhood: p.neighborhood || null,
            city: p.city || null,
            state: p.state || null,
          },
        },
      }),
    onSuccess: (t2) => {
      setTenant(t2);
      setSaved(true);
    },
  });

  /** Looks up the typed address with OpenStreetMap's geocoder (one request, user-initiated). */
  const findOnMap = async () => {
    const q = [p.address, p.neighborhood, p.city, p.state, 'México'].filter(Boolean).join(', ');
    if (!q) return;
    setFinding(true);
    setFindError(false);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=mx&q=${encodeURIComponent(q)}`, {
        headers: { Accept: 'application/json' },
      });
      const [hit] = (await res.json()) as { lat: string; lon: string }[];
      if (hit) set({ lat: Number(hit.lat), lng: Number(hit.lon) });
      else setFindError(true);
    } catch {
      setFindError(true);
    } finally {
      setFinding(false);
    }
  };

  const useMyLocation = () =>
    navigator.geolocation?.getCurrentPosition(
      (pos) => set({ lat: Number(pos.coords.latitude.toFixed(6)), lng: Number(pos.coords.longitude.toFixed(6)) }),
      () => setFindError(true),
    );

  const markers = useMemo(
    () =>
      p.lat != null && p.lng != null
        ? [{ id: 'me', lat: p.lat, lng: p.lng, color: TYPE_COLORS[tenant!.businessType] ?? '#0f766e', title: tenant!.name }]
        : [],
    [p.lat, p.lng, tenant],
  );
  const canList = p.lat != null && Boolean(p.city);

  return (
    <section className="card space-y-4 lg:col-span-2" id="perfil">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{t('profile.title')}</h2>
          <p className="text-sm text-slate-500">{t('profile.subtitle')}</p>
        </div>
        <Link to="/" target="_blank" className="text-sm font-medium text-brand-700">{t('profile.viewDirectory')} ↗</Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div>
            <label className="label">{t('profile.description')}</label>
            <textarea className="input" rows={3} maxLength={500} disabled={disabled} placeholder={t('profile.descriptionPlaceholder')} value={p.description ?? ''} onChange={(e) => set({ description: e.target.value })} />
          </div>
          <div>
            <label className="label">{t('profile.address')}</label>
            <input className="input" disabled={disabled} placeholder="Av. Reforma 123" value={p.address ?? ''} onChange={(e) => set({ address: e.target.value })} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">{t('profile.neighborhood')}</label>
              <input className="input" disabled={disabled} value={p.neighborhood ?? ''} onChange={(e) => set({ neighborhood: e.target.value })} />
            </div>
            <div>
              <label className="label">{t('profile.city')}</label>
              <input className="input" disabled={disabled} value={p.city ?? ''} onChange={(e) => set({ city: e.target.value })} />
            </div>
          </div>
          <div>
            <label className="label">{t('profile.state')}</label>
            <select className="input" disabled={disabled} value={p.state ?? ''} onChange={(e) => set({ state: e.target.value || null })}>
              <option value="">—</option>
              {MX_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="label mb-0">{t('profile.location')}</span>
            {!disabled && (
              <div className="flex gap-2">
                <button type="button" className="btn-secondary !py-1 text-sm" onClick={findOnMap} disabled={finding}>
                  {finding ? t('common.loading') : t('profile.findAddress')}
                </button>
                <button type="button" className="btn-secondary !py-1 text-sm" onClick={useMyLocation}>◎ {t('profile.myLocation')}</button>
              </div>
            )}
          </div>
          <MapView
            markers={markers}
            onPick={disabled ? undefined : (lat, lng) => set({ lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) })}
            fitKey={`${p.lat},${p.lng}`}
            className="h-64"
          />
          <p className="text-xs text-slate-500">{p.lat != null ? t('profile.pinSet') : t('profile.pinHelp')}</p>
          {findError && <p className="text-xs text-amber-700">{t('profile.findError')}</p>}
        </div>
      </div>

      <label className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${canList ? 'border-slate-200' : 'border-dashed border-slate-300 text-slate-500'}`}>
        <input type="checkbox" className="mt-0.5" disabled={disabled || !canList} checked={p.directoryListed && canList} onChange={(e) => set({ directoryListed: e.target.checked })} />
        <span>
          <span className="font-medium text-slate-800">{t('profile.listMe')}</span>
          <span className="block text-slate-500">{canList ? t('profile.listMeHelp') : t('profile.listMeNeeds')}</span>
        </span>
      </label>

      {!disabled && (
        <div className="flex items-center gap-3">
          <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{t('common.save')}</button>
          {saved && <span className="text-sm text-emerald-700">{t('common.saved')}</span>}
        </div>
      )}
      <ErrorText error={save.error} ns="profile" />
    </section>
  );
}
