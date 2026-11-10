import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageLookSection } from '../components/PageLook';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  assignableRoles,
  BUSINESS_TYPES,
  isManager,
  isValidClabe,
  kindConfig,
  paymentSettingsOf,
  pageSettingsOf,
  rentalSettingsOf,
  reservationSettingsOf,
  selfServiceOf,
  type BusinessKind,
  type Role,
  type SessionUser,
  type TenantDto,
  type LocationDto,
  type TenantSettings,
  type UserDto,
} from '@agenda/shared';
import { PaymentSettingsSection } from '../components/PaymentSettings';
import { HoursFields } from '../components/Schedule';
import { PublicProfileSection } from '../components/PublicProfile';
import { LocationSelect, LocationsSection } from '../components/Locations';
import { PlanSection } from '../components/Plans';
import { ErrorText, Modal, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAccess, useAuth } from '../lib/auth';
import { useMyLocations, useResources } from '../lib/queries';

export function SettingsPage() {
  const { user } = useAuth();
  if (!isManager(user?.role)) return <MemberSettings />;
  return <BusinessSettings />;
}

/** Colaboradores: their own account and language, plus the public link to share. */
function MemberSettings() {
  const { t } = useTranslation();
  const { tenant } = useAuth();
  const publicUrl = `${window.location.origin}/b/${tenant?.slug}`;
  return (
    <>
      <PageHeader title={t('settings.title')} />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <AccountSection />
        <section className="card space-y-4">
          <h2 className="font-semibold">{t('settings.business')}</h2>
          <div className="text-sm text-slate-700">{tenant?.name}</div>
          <LanguageSelect />
          <div>
            <div className="label">{t('settings.publicLink')}</div>
            <input readOnly className="input" value={publicUrl} onFocus={(e) => e.target.select()} />
          </div>
          <p className="text-sm text-slate-500">{t('settings.memberHelp')}</p>
        </section>
      </div>
    </>
  );
}

function LanguageSelect() {
  const { t, i18n } = useTranslation();
  return (
    <div>
      <label className="label">{t('settings.language')}</label>
      <select
        className="input"
        value={i18n.language.startsWith('en') ? 'en' : 'es'}
        onChange={(e) => {
          void i18n.changeLanguage(e.target.value);
          try { localStorage.setItem('agenda.lang', e.target.value); } catch { /* ignore */ }
        }}
      >
        <option value="es">Español</option>
        <option value="en">English</option>
      </select>
    </div>
  );
}

function AccountSection() {
  const { t } = useTranslation();
  const { user, setUser } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () =>
      api<SessionUser>('/auth/me', {
        method: 'PATCH',
        body: { name, ...(newPassword ? { currentPassword, newPassword } : {}) },
      }),
    onSuccess: (u) => {
      setUser(u);
      setCurrent('');
      setNew('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });
  return (
    <section className="card space-y-4">
      <h2 className="font-semibold">{t('settings.account')}</h2>
      <div className="text-sm text-slate-500">
        {user?.email} · <span className="font-medium text-slate-700">{t(`settings.role.${user?.role ?? 'staff'}`)}</span>
      </div>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div>
          <label className="label">{t('auth.name')}</label>
          <input required minLength={2} className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">{t('settings.currentPassword')}</label>
            <input type="password" autoComplete="current-password" className="input" value={currentPassword} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div>
            <label className="label">{t('settings.newPassword')}</label>
            <input type="password" autoComplete="new-password" minLength={8} className="input" value={newPassword} onChange={(e) => setNew(e.target.value)} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button className="btn-secondary" disabled={save.isPending || (Boolean(newPassword) && !currentPassword)}>{t('common.save')}</button>
          {saved && <span className="text-sm text-emerald-700">{t('common.saved')}</span>}
        </div>
        <ErrorText error={save.error} ns="settings" />
      </form>
    </section>
  );
}

function BusinessSettings() {
  const { t, i18n } = useTranslation();
  const { tenant, user, setTenant } = useAuth();
  // Admins edit the business like the owner; payouts (bank / Mercado Pago) stay with the owner.
  // Managers limited to one location (gerentes) only see business settings.
  const { businessManager } = useAccess();
  const canEdit = isManager(user?.role) && businessManager;
  const isOwner = user?.role === 'owner';
  const [name, setName] = useState(tenant?.name ?? '');
  const [businessType, setBusinessType] = useState(tenant?.businessType ?? 'other');
  const [phone, setPhone] = useState(tenant?.phone ?? '');
  const [settings, setSettings] = useState<TenantSettings>({
    ...tenant!.settings,
    payments: paymentSettingsOf(tenant!.settings),
    selfService: selfServiceOf(tenant!.settings),
    reservations: reservationSettingsOf(tenant!.settings),
    rentals: rentalSettingsOf(tenant!.settings),
    page: pageSettingsOf(tenant!.settings),
  });
  const kind = tenant?.kind ?? 'appointments';
  const isRentals = kindConfig(kind).durations;
  const durations = settings.rentals!.durations;
  const toggleDuration = (m: number) =>
    setSettings((x) => {
      const cur = x.rentals!.durations;
      const next = cur.includes(m) ? cur.filter((d) => d !== m) : [...cur, m].sort((a, b) => a - b);
      return next.length ? { ...x, rentals: { durations: next } } : x;
    });
  const isRestaurant = kindConfig(kind).partySize;
  const rs = settings.reservations!;
  const setRs = (patch: Partial<typeof rs>) => setSettings((x) => ({ ...x, reservations: { ...x.reservations!, ...patch } }));
  const selfService = settings.selfService!;
  const setSelfService = (patch: Partial<typeof selfService>) =>
    setSettings((s) => ({ ...s, selfService: { ...s.selfService!, ...patch } }));
  const payments = settings.payments!;
  const invalid = payments.transfer.clabe !== '' && !isValidClabe(payments.transfer.clabe);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      api<TenantDto>('/tenant', {
        method: 'PATCH',
        body: { name, businessType, phone: phone || null, settings, locale: i18n.language.startsWith('en') ? 'en' : 'es' },
      }),
    onSuccess: (t2) => {
      setTenant(t2);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const publicUrl = `${window.location.origin}/b/${tenant?.slug}`;
  const setHours = (patch: Partial<TenantSettings['hours']>) =>
    setSettings((s) => ({ ...s, hours: { ...s.hours, ...patch } }));

  const [params, setParams] = useSearchParams();
  const tabs = [
    { id: 'business', label: t('settings.tabs.business') },
    { id: 'booking', label: t('settings.tabs.booking') },
    { id: 'payments', label: t('settings.tabs.payments') },
    ...(businessManager ? [{ id: 'locations', label: t('settings.tabs.locations') }] : []),
    { id: 'users', label: t('settings.tabs.users') },
    ...(businessManager ? [{ id: 'plan', label: t('settings.tabs.plan') }] : []),
    { id: 'account', label: t('settings.tabs.account') },
  ];
  const tab = tabs.some((x) => x.id === params.get('tab')) ? params.get('tab')! : 'business';
  // Tabs that share one "Guardar" (business data, booking rules, payments)
  const saveBar = canEdit && ['business', 'booking', 'payments'].includes(tab) && (
    <div className="flex items-center gap-3">
      <button className="btn-primary" disabled={save.isPending || invalid} onClick={() => save.mutate()}>{t('common.save')}</button>
      {saved && <span className="text-sm text-emerald-700">{t('common.saved')}</span>}
      <ErrorText error={save.error} ns="paymentSettings" />
    </div>
  );

  return (
    <>
      <PageHeader title={t('settings.title')} />
      <div role="tablist" aria-label={t('settings.title')} className="-mx-1 mb-6 flex gap-1 overflow-x-auto border-b border-slate-200 px-1">
        {tabs.map((x) => (
          <button
            key={x.id}
            role="tab"
            type="button"
            aria-selected={tab === x.id}
            onClick={() => setParams(x.id === 'business' ? {} : { tab: x.id }, { replace: true })}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${tab === x.id ? 'border-brand-600 text-brand-800' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          >
            {x.label}
          </button>
        ))}
      </div>

      {tab === 'business' && (
        <div className="space-y-6">
          <div className="grid items-start gap-6 lg:grid-cols-2">
        <section className="card space-y-4">
          <h2 className="font-semibold">{t('settings.business')}</h2>
          <div>
            <label className="label">{t('auth.businessName')}</label>
            <input className="input" value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="label">{t('auth.businessType')}</label>
              <select className="input" value={businessType} disabled={!canEdit} onChange={(e) => setBusinessType(e.target.value as typeof businessType)}>
                {BUSINESS_TYPES.map((b) => <option key={b} value={b}>{t(`businessTypes.${b}`)}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{t('auth.phone')}</label>
              <input className="input" value={phone} disabled={!canEdit} onChange={(e) => setPhone(e.target.value)} />
            </div>
          </div>
          <div className="text-sm text-slate-500">{t('settings.timezone')}: {tenant?.timezone}</div>
          <Link to="/resources" className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-sm hover:border-brand-500">
            <span>
              <span className="font-medium text-slate-800">{t(`kinds.${kind}.resources`)}</span>
              <span className="block text-slate-500">{t(`kinds.${kind}.resourcesHelp`)}</span>
            </span>
            <span className="text-brand-700">→</span>
          </Link>
        </section>

        <section className="card space-y-4 ">
          <h2 className="font-semibold">{t('settings.hours')}</h2>
          <HoursFields idPrefix="biz-hours" disabled={!canEdit} value={settings.hours} onChange={(h) => setHours(h)} />
          <div className="max-w-[12rem]">
            <label className="label" htmlFor="biz-slot">{t('settings.slotMinutes')}</label>
            <select id="biz-slot" disabled={!canEdit} className="input" value={settings.hours.slotMinutes} onChange={(e) => setHours({ slotMinutes: Number(e.target.value) })}>
              {[15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </section>

          </div>
          <PageLookSection
            value={pageSettingsOf(settings)}
            onChange={(p) => setSettings((s) => ({ ...s, page: p }))}
            disabled={!canEdit}
            name={name}
            slug={tenant!.slug}
          />
          {saveBar}
          <div className="grid items-start gap-6 lg:grid-cols-2">
            <PublicProfileSection disabled={!canEdit} />
          </div>
        </div>
      )}

      {tab === 'booking' && (
        <div className="space-y-6">
          <div className="grid items-start gap-6 lg:grid-cols-2">
        <section className="card space-y-4">
          <h2 className="font-semibold">{t('settings.publicLink')}</h2>
          <div className="flex gap-2">
            <input readOnly className="input" value={publicUrl} onFocus={(e) => e.target.select()} />
            <button
              className="btn-secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(publicUrl);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? t('common.copied') : t('common.copy')}
            </button>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={!canEdit} checked={settings.onlineBookingEnabled} onChange={(e) => setSettings({ ...settings, onlineBookingEnabled: e.target.checked })} />
            {t('settings.onlineBookingEnabled')}
          </label>

          {isRestaurant && (
            <>
              <h2 className="pt-2 font-semibold">{t('tables.settingsTitle')}</h2>
              <div className="grid max-w-md gap-3 sm:grid-cols-2">
                <div>
                  <label className="label">{t('tables.duration')}</label>
                  <select disabled={!canEdit} className="input" value={rs.durationMin} onChange={(e) => setRs({ durationMin: Number(e.target.value) })}>
                    {[60, 75, 90, 105, 120, 150, 180].map((m) => <option key={m} value={m}>{m} {t('common.minutes')}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">{t('tables.maxParty')}</label>
                  <input type="number" min={1} max={50} disabled={!canEdit} className="input" value={rs.maxPartySize} onChange={(e) => setRs({ maxPartySize: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })} />
                </div>
              </div>
            </>
          )}

          {isRentals && (
            <>
              <h2 className="pt-2 font-semibold">{t('spaces.settingsTitle')}</h2>
              <p className="text-sm text-slate-500">{t('spaces.durationsHelp')}</p>
              <div className="flex flex-wrap gap-2">
                {[30, 60, 90, 120, 150, 180, 240].map((m) => {
                  const on = durations.includes(m);
                  return (
                    <button
                      key={m}
                      type="button"
                      disabled={!canEdit}
                      aria-pressed={on}
                      onClick={() => toggleDuration(m)}
                      className={`rounded-lg border px-3 py-1.5 text-sm ${on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-slate-300 text-slate-500'}`}
                    >
                      {m} {t('common.minutes')}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <h2 className="pt-2 font-semibold">{t('settings.selfService')}</h2>
          <p className="text-sm text-slate-500">{t('settings.selfServiceHelp')}</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={!canEdit} checked={selfService.rescheduleEnabled} onChange={(e) => setSelfService({ rescheduleEnabled: e.target.checked })} />
            {t('settings.rescheduleEnabled')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={!canEdit} checked={selfService.cancelEnabled} onChange={(e) => setSelfService({ cancelEnabled: e.target.checked })} />
            {t('settings.cancelEnabled')}
          </label>
          {(selfService.rescheduleEnabled || selfService.cancelEnabled) && (
            <div className="max-w-56">
              <label className="label">{t('settings.minHoursNotice')}</label>
              <input type="number" min={0} max={168} disabled={!canEdit} className="input" value={selfService.minHoursNotice} onChange={(e) => setSelfService({ minHoursNotice: Math.max(0, Math.min(168, Number(e.target.value) || 0)) })} />
            </div>
          )}

          <h2 className="pt-2 font-semibold">{t('settings.reminders')}</h2>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" disabled={!canEdit} checked={settings.remindersEnabled} onChange={(e) => setSettings({ ...settings, remindersEnabled: e.target.checked })} />
            {t('settings.remindersEnabled')}
          </label>
          <div className="max-w-48">
            <label className="label">{t('settings.reminderHoursBefore')}</label>
            <input type="number" min={1} max={72} disabled={!canEdit} className="input" value={settings.reminderHoursBefore} onChange={(e) => setSettings({ ...settings, reminderHoursBefore: Number(e.target.value) })} />
          </div>
        </section>

          </div>
          {saveBar}
        </div>
      )}

      {tab === 'payments' && (
        <div className="space-y-6">
          <div className="grid items-start gap-6 lg:grid-cols-2">
        <PaymentSettingsSection
          value={payments}
          disabled={!isOwner}
          onChange={(p) => setSettings((s) => ({ ...s, payments: p }))}
        />
          </div>
          {saveBar}
        </div>
      )}

      {tab === 'locations' && <LocationsSection editable={businessManager} />}
      {tab === 'users' && <UsersSection kind={kind} />}
      {tab === 'plan' && <PlanSection canChange={isOwner} />}
      {tab === 'account' && (
        <div className="grid items-start gap-6 lg:grid-cols-2">
          <AccountSection />
          <section className="card space-y-4">
            <LanguageSelect />
          </section>
        </div>
      )}
    </>
  );
}

type UserForm = { name: string; email: string; password: string; role: Role; resourceId: string; locationId: string };

/** Logins with access to the business, their role and which team member's agenda they work. */
function UsersSection({ kind }: { kind: BusinessKind }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const qc = useQueryClient();
  const roles = assignableRoles(user!.role);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<UserDto[]>('/users') });
  const pros = useResources();
  const [editing, setEditing] = useState<UserDto | 'new' | null>(null);
  const { locationId: ownLocation } = useAccess();
  const locs = useMyLocations(ownLocation);
  const memberWord = t(`kinds.${kind}.resource`);
  return (
    <section className="card mt-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">{t('settings.logins')}</h2>
        {roles.length > 0 && <button className="btn-secondary" onClick={() => setEditing('new')}>{t('settings.addUser')}</button>}
      </div>
      <p className="mb-3 text-sm text-slate-500">{t('settings.rolesHelpTeam')}</p>
      <ul className="divide-y divide-slate-100 text-sm">
        {(users.data ?? []).map((u) => {
          const manageable = u.id === user!.id || roles.includes(u.role);
          return (
            <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="min-w-0">
                <span className="font-medium text-slate-800">{u.name}</span>
                {u.id === user!.id && <span className="text-slate-400"> ({t('settings.you')})</span>}
                <span className="block truncate text-slate-500">{u.email}</span>
              </span>
              <span className="flex items-center gap-2">
                {locs.anyMulti && u.role !== 'owner' && (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{u.locationName ?? t('locations.all')}</span>
                )}
                {u.resourceName && (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{memberWord}: {u.resourceName}</span>
                )}
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${u.role === 'staff' ? 'bg-sky-50 text-sky-700' : u.role === 'admin' ? 'bg-violet-50 text-violet-700' : 'bg-amber-50 text-amber-800'}`}>
                  {t(`settings.role.${u.role}`)}
                </span>
                {manageable && (
                  <button className="text-sm font-medium text-brand-700 hover:underline" onClick={() => setEditing(u)} aria-label={`${t('common.edit')} ${u.name}`}>
                    {t('common.edit')}
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-4 grid gap-2 text-xs text-slate-500 sm:grid-cols-3">
        {(['owner', 'admin', 'staff'] as const).map((r) => (
          <div key={r} className="rounded-lg bg-slate-50 p-2.5">
            <div className="font-semibold text-slate-700">{t(`settings.role.${r}`)}</div>
            {t(`settings.roleHelp.${r}`)}
          </div>
        ))}
      </div>
      {editing && (
        <UserModal
          target={editing === 'new' ? null : editing}
          roles={roles}
          memberWord={memberWord}
          pros={pros.data ?? []}
          users={users.data ?? []}
          locations={locs.anyMulti ? locs.list : []}
          ownLocation={ownLocation}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey: ['users'] });
            void qc.invalidateQueries({ queryKey: ['resources'] });
          }}
        />
      )}
    </section>
  );
}

function UserModal({
  target,
  roles,
  memberWord,
  pros,
  users,
  locations,
  ownLocation,
  onClose,
  onDone,
}: {
  target: UserDto | null;
  roles: Role[];
  memberWord: string;
  pros: { id: string; name: string; active: boolean; locationId: string }[];
  users: UserDto[];
  locations: LocationDto[];
  ownLocation: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const self = target?.id === user!.id;
  // People who also use other businesses manage their own name and password.
  const lockedAccount = Boolean(target?.sharedAccount && !self);
  const [form, setForm] = useState<UserForm>({
    name: target?.name ?? '',
    email: target?.email ?? '',
    password: '',
    role: target?.role ?? 'staff',
    resourceId: target?.resourceId ?? '',
    locationId: target?.locationId ?? ownLocation ?? '',
  });
  const takenBy = new Map(users.filter((u) => u.resourceId && u.id !== target?.id).map((u) => [u.resourceId!, u.name]));
  const save = useMutation({
    mutationFn: () => {
      const resourceId = form.resourceId || null;
      const locationId = locations.length && form.role !== 'owner' ? form.locationId || null : undefined;
      if (!target) {
        return api('/users', { method: 'POST', body: { name: form.name, email: form.email, password: form.password, role: form.role, resourceId, locationId } });
      }
      return api(`/users/${target.id}`, {
        method: 'PATCH',
        body: {
          ...(lockedAccount ? {} : { name: form.name }),
          ...(self ? {} : { role: form.role }),
          ...(form.password ? { password: form.password } : {}),
          resourceId,
          ...(self ? {} : { locationId }),
        },
      });
    },
    onSuccess: onDone,
  });
  const remove = useMutation({
    mutationFn: () => api(`/users/${target!.id}`, { method: 'DELETE' }),
    onSuccess: onDone,
  });
  const roleOptions = target && !roles.includes(target.role) ? [target.role, ...roles] : roles;
  return (
    <Modal open title={target ? t('settings.editUser') : t('settings.addUser')} onClose={onClose}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div>
          <label className="label" htmlFor="u-name">{t('auth.name')}</label>
          <input id="u-name" required minLength={2} className="input" disabled={lockedAccount} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        {!target && (
          <div>
            <label className="label" htmlFor="u-email">{t('auth.email')}</label>
            <input id="u-email" required type="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
        )}
        {!lockedAccount && (
        <div>
          <label className="label" htmlFor="u-pass">{target ? t('settings.resetPassword') : t('auth.password')}</label>
          <input
            id="u-pass"
            type="password"
            autoComplete="new-password"
            required={!target}
            minLength={8}
            className="input"
            placeholder={target ? t('settings.resetPasswordHelp') : ''}
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          {!target && <p className="mt-1 text-xs text-slate-500">{t('settings.existingAccountHelp')}</p>}
        </div>
        )}
        <div>
          <label className="label" htmlFor="u-role">{t('settings.roleLabel')}</label>
          <select id="u-role" className="input" disabled={self} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {roleOptions.map((r) => <option key={r} value={r}>{t(`settings.role.${r}`)}</option>)}
          </select>
          <p className="mt-1 text-xs text-slate-500">{t(`settings.roleHelp.${form.role}`)}</p>
        </div>
        {locations.length > 0 && form.role !== 'owner' && (
          <div>
            <label className="label" htmlFor="u-loc">{t('locations.location')}</label>
            {ownLocation ? (
              <p className="text-sm text-slate-700">{locations.find((l) => l.id === ownLocation)?.name}</p>
            ) : (
              <LocationSelect id="u-loc" value={form.locationId} onChange={(v) => setForm({ ...form, locationId: v })} list={locations} allLabel={t('locations.all')} />
            )}
            <p className="mt-1 text-xs text-slate-500">{t('locations.userHelp')}</p>
          </div>
        )}
        {target?.sharedAccount && !self && <p className="text-xs text-slate-500">{t('settings.sharedAccount')}</p>}
        {pros.length > 0 && (
          <div>
            <label className="label" htmlFor="u-pro">{memberWord}</label>
            <select id="u-pro" className="input" value={form.resourceId} onChange={(e) => setForm({ ...form, resourceId: e.target.value })}>
              <option value="">{t('settings.noLink')}</option>
              {pros.filter((p) => p.active || p.id === form.resourceId).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}{takenBy.has(p.id) ? ` (${t('settings.linkedTo', { name: takenBy.get(p.id) })})` : ''}
                </option>
              ))}
            </select>
            {form.role === 'staff' && !form.resourceId && <p className="mt-1 text-xs text-amber-700">{t('settings.staffNeedsLink')}</p>}
          </div>
        )}
        <ErrorText error={save.error ?? remove.error} ns="settings" />
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          {target && !self ? (
            <button
              type="button"
              className="text-sm font-medium text-rose-700 hover:underline"
              disabled={remove.isPending}
              onClick={() => window.confirm(t('settings.removeUserConfirm', { name: target.name })) && remove.mutate()}
            >
              {t('settings.removeUser')}
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
