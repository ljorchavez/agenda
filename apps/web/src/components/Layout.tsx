import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../lib/auth';

const NAV = [
  { to: '/', key: 'dashboard', icon: '◧', end: true },
  { to: '/agenda', key: 'agenda', icon: '▦' },
  { to: '/customers', key: 'customers', icon: '☺' },
  { to: '/services', key: 'services', icon: '✂' },
  { to: '/payments', key: 'payments', icon: '$' },
  { to: '/settings', key: 'settings', icon: '⚙' },
] as const;

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
          <div className="text-lg font-bold text-brand-700">Agenda</div>
          <div className="truncate text-sm text-slate-500">{tenant?.name}</div>
        </div>
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={'end' in n} className={linkClass}>
              <span className="w-5 text-center">{n.icon}</span>
              {t(`nav.${n.key}`)}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-200 pt-3">
          <div className="mb-2 truncate px-2 text-xs text-slate-500">{user?.email}</div>
          <div className="flex items-center justify-between px-2">
            <button
              className="text-sm text-slate-600 hover:text-slate-900"
              onClick={() => {
                logout();
                navigate('/login');
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
        <div className="truncate px-2 text-sm text-slate-500">{tenant?.name}</div>
        <LanguageSwitch />
      </header>

      <main className="px-4 pb-24 pt-6 md:ml-60 md:px-8 md:pb-10">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-t border-slate-200 bg-white md:hidden">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={'end' in n}
            className={({ isActive }) =>
              `flex flex-col items-center py-2 text-[11px] ${isActive ? 'text-brand-700' : 'text-slate-500'}`
            }
          >
            <span className="text-base">{n.icon}</span>
            {t(`nav.${n.key}`)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
