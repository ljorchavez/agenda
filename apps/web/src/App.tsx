import { ReviewPage } from './pages/Review';
import { PurchasePage } from './components/Shop';
import type { ReactElement } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { ClinicalPrintPage } from './components/ClinicalRecord';
import { PortalPage, PrescriptionPage } from './pages/Portal';
import { useTranslation } from 'react-i18next';
import { Layout } from './components/Layout';
import { useAuth } from './lib/auth';
import { NewBusinessPage } from './pages/NewBusiness';
import { AgendaPage } from './pages/Agenda';
import { BookingPage } from './pages/Booking';
import { CustomerDetailPage } from './pages/CustomerDetail';
import { CustomersPage } from './pages/Customers';
import { DirectoryPage } from './pages/Directory';
import { RegisterPage, ResetPasswordPage } from './pages/Auth';
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
  if (!user) return <Navigate to="/?login=1" replace />;
  return children;
}

/** Old links keep working: /directorio is now the home page and /login opens its sign-in window. */
function Redirect({ to }: { to: string }) {
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const [path, extra] = to.split('?');
  if (extra) new URLSearchParams(extra).forEach((v, k) => params.set(k, v));
  const qs = params.toString();
  return <Navigate to={`${path}${qs ? `?${qs}` : ''}`} replace />;
}

function PrintRecord() {
  const { id } = useParams();
  return <ClinicalPrintPage customerId={id!} />;
}

export function App() {
  return (
    <Routes>
      {/* Home: public directory/map of businesses, with the sign-in window */}
      <Route path="/" element={<DirectoryPage />} />
      <Route path="/directorio" element={<Redirect to="/" />} />
      <Route path="/login" element={<Redirect to="/?login=1" />} />
      <Route path="/registro" element={<RegisterPage />} />
      <Route path="/register" element={<Redirect to="/registro" />} />
      <Route path="/restablecer" element={<ResetPasswordPage />} />
      {/* Public booking page for end customers */}
      <Route path="/b/:slug" element={<BookingPage />} />
      {/* Private link for a customer to reschedule/cancel their appointment */}
      <Route path="/c/:token" element={<ManagePage />} />
      <Route path="/r/:token" element={<ReviewPage />} />
      <Route path="/compra/:token" element={<PurchasePage />} />
      {/* Patient/customer portal (magic link by email) and public check of a signed prescription */}
      <Route path="/p/:slug" element={<PortalPage />} />
      <Route path="/receta/:token" element={<PrescriptionPage />} />
      {/* Printable clinical documents: no menus, letterhead only */}
      <Route path="/customers/:id/imprimir" element={<Protected><PrintRecord /></Protected>} />
      {/* The business back office */}
      <Route
        element={
          <Protected>
            <Layout />
          </Protected>
        }
      >
        {/* "Inicio" was merged into Reportes */}
        <Route path="inicio" element={<Navigate to="/reports" replace />} />
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
