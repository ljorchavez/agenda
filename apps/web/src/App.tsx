import type { ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Layout } from './components/Layout';
import { useAuth } from './lib/auth';
import { NewBusinessPage } from './pages/NewBusiness';
import { AgendaPage } from './pages/Agenda';
import { BookingPage } from './pages/Booking';
import { CustomerDetailPage } from './pages/CustomerDetail';
import { CustomersPage } from './pages/Customers';
import { DashboardPage } from './pages/Dashboard';
import { DirectoryPage } from './pages/Directory';
import { LoginPage, RegisterPage } from './pages/Auth';
import { ManagePage } from './pages/Manage';
import { PaymentsPage } from './pages/Payments';
import { ReportsPage } from './pages/Reports';
import { ServicesPage } from './pages/Services';
import { SettingsPage } from './pages/Settings';
import { ResourcesPage } from './pages/Resources';

function Protected({ children }: { children: ReactElement }) {
  const { user, loading } = useAuth();
  const { t } = useTranslation();
  if (loading) return <div className="p-8 text-slate-500">{t('common.loading')}</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      {/* Public booking page for end customers */}
      <Route path="/b/:slug" element={<BookingPage />} />
      {/* Private link for a customer to reschedule/cancel their appointment */}
      <Route path="/c/:token" element={<ManagePage />} />
      {/* Public directory/map of businesses (no login) */}
      <Route path="/directorio" element={<DirectoryPage />} />
      <Route
        path="/"
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="agenda" element={<AgendaPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="customers/:id" element={<CustomerDetailPage />} />
        <Route path="services" element={<ServicesPage />} />
        <Route path="payments" element={<PaymentsPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="resources" element={<ResourcesPage />} />
        {/* Old per-kind pages, now one calendar and one resources page */}
        {['team', 'tables', 'spaces'].map((p) => <Route key={p} path={p} element={<Navigate to="/resources" replace />} />)}
        <Route path="classes" element={<Navigate to="/agenda" replace />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="new-business" element={<NewBusinessPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
