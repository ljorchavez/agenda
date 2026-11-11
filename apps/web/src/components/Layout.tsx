import { InstallAppBanner } from './InstallApp';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { isManager, kindConfig, type BusinessKind } from '@agenda/shared';
import { useAuth } from '../lib/auth';

type NavItem = { to: string; key: string; icon: string; end?: boolean; desktopOnly?: boolean };

const NAV: NavItem[] = [
  // The agenda is the daily screen, so it comes first (and is where login lands).
  { to: '/agenda', key: 'calendar', icon: '▦' },
  { to: '/customers', key: 'customers', icon: '☺' },
  { to: '/services', key: 'services', icon: '✂' },
  { to: '/resources', key: 'resources', icon: '♟', desktopOnly: true },
  { to: '/payments', key: 'payments', icon: '$' },
  { to: '/reports', key: 'reports', icon: '▤' },
  { to: '/settings', key: 'settings', icon: '⚙' },
];

/**
 * Same sections for every kind of business; only the wording changes (i18n `kinds.<kind>.*`).
 * Kinds that book without choosing a service (party size, duration) don't need the catalogue.
 */
function navFor(kind: BusinessKind, manager: boolean): (NavItem & { label: string; short: string })[] {
  const cfg = kindConfig(kind);
  return NAV.filter((n) => {
    // Team members (colaboradores) work their own book; catalogue and resources stay with managers.
    if (!manager && (n.key === 'services' || n.key === 'resources')) return false;
    if (n.key === 'services' && (cfg.partySize || cfg.durations)) return false;
    return true;
  }).map((n) => {
    const perKind = ['calendar', 'services', 'resources'].includes(n.key);
    return { ...n, label: perKind ? `kinds.${kind}.${n.key}` : `nav.${n.key}`, short: perKind ? `kinds.${kind}.${n.key}Short` : `navShort.${n.key}` };
  });
}

/** Shows the current business and lets the owner jump to another one (or open a new one). */
function BusinessSwitcher({ className = '' }: { className?: string }) {
  const { t } = useTranslation();
  const { tenant, businesses, switchBusiness } = useAuth();
  const navigate = useNavigate();
  return (
    <select
      aria-label={t('business.switch')}
      className={`w-full truncate rounded-md border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700 ${className}`}
      value={tenant?.id ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        if (v === '__new') return navigate('/new-business');
        void switchBusiness(v).then(() => navigate('/agenda'));
      }}
    >
      {(businesses.length ? businesses : tenant ? [{ id: tenant.id, name: tenant.name }] : []).map((b) => (
        <option key={b.id} value={b.id}>{b.name}</option>
      ))}
      <option value="__new">{t('business.new')}</option>
    </select>
  );
}

export function LanguageSwitch({ className = '' }: { className?: string }) {
  const { i18n } = useTranslation();
  const next = i18n.language.startsWith('en') ? 'es' : 'en';
  return (
    <button
      onClick={() => {
        void i18n.changeLanguage(next);
        try {
          localStorage.setItem('agenda.lang', next);
        } catch {
          /* ignore */
        }
      }}
      className={`rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 ${className}`}
    >
      {next.toUpperCase()}
    </button>
  );
}

export function Layout() {
  const { t } = useTranslation();
  const { tenant, user, logout } = useAuth();
  const nav = navFor(tenant?.kind ?? 'appointments', isManager(user?.role));
  const mobileNav = nav.filter((n) => !n.desktopOnly);
  const navigate = useNavigate();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
      isActive ? 'bg-brand-50 text-brand-800' : 'text-slate-600 hover:bg-slate-100'
    }`;

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-slate-200 bg-white p-4 md:flex">
        <div className="mb-6 px-2">
          <div className="mb-1 text-lg font-bold text-brand-700">Agenda</div>
          <BusinessSwitcher />
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={linkClass}>
              <span className="w-5 text-center">{n.icon}</span>
              {t(n.label)}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-200 pt-3">
          <div className="mb-2 px-2 text-xs text-slate-500">
            <div className="truncate font-medium text-slate-700">{user?.name}</div>
            <div className="truncate">{user?.email} · {t(`settings.role.${user?.role ?? 'staff'}`)}</div>
          </div>
          <div className="flex items-center justify-between px-2">
            <button
              className="text-sm text-slate-600 hover:text-slate-900"
              onClick={() => {
                logout();
                navigate('/');
              }}
            >
              {t('nav.logout')}
            </button>
            <LanguageSwitch />
          </div>
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3 md:hidden">
        <div className="font-bold text-brand-700">Agenda</div>
        <BusinessSwitcher className="mx-2 min-w-0 flex-1" />
        <LanguageSwitch />
      </header>

      <main className="px-4 pb-24 pt-6 md:ml-60 md:px-8 md:pb-10">
        <div className="mx-auto max-w-6xl">
          <InstallAppBanner />
          <Outlet />
        </div>
      </main>

      {/* Mobile bottom nav */}
      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid border-t border-slate-200 bg-white md:hidden"
        style={{ gridTemplateColumns: `repeat(${mobileNav.length}, minmax(0, 1fr))` }}
      >
        {mobileNav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `flex min-w-0 flex-col items-center py-2 text-[10px] ${isActive ? 'text-brand-700' : 'text-slate-500'}`
            }
          >
            <span className="text-base">{n.icon}</span>
            <span className="w-full truncate px-0.5 text-center">{t(n.short)}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
