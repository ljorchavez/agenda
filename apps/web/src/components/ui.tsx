import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppointmentDto, AppointmentStatus } from '@agenda/shared';
import { ApiError } from '../lib/api';
import { STATUS_COLORS } from '../lib/format';
import { BOOKING_ICON, PAYMENT_PILL, PAYMENT_PILL_TEXT, paymentState } from '../lib/status';

export function Modal({
  open,
  title,
  onClose,
  children,
  wide,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:rounded-2xl ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'}`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:text-slate-700" aria-label="close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function StatusBadge({ status }: { status: AppointmentStatus }) {
  const { t } = useTranslation();
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[status]}`}>
      <span aria-hidden>{BOOKING_ICON[status]}</span>
      {t(`status.${status}`)}
    </span>
  );
}

/** Shows an API error translated by its code when a translation exists. */
export function ErrorText({ error, ns }: { error: unknown; ns?: string }) {
  const { t, i18n } = useTranslation();
  if (!error) return null;
  let msg = t('common.error');
  if (error instanceof ApiError) {
    const key = ns ? `${ns}.${error.code}` : '';
    if (key && i18n.exists(key)) msg = t(key);
    else if (i18n.exists(`errors.${error.code}`)) msg = t(`errors.${error.code}`);
    else if (error.message && error.message !== error.code) msg = error.message;
  }
  return <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{msg}</p>;
}

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">{children}</div>;
}

export function Loading() {
  const { t } = useTranslation();
  return <div className="p-6 text-slate-500">{t('common.loading')}</div>;
}

/** Payment state of a booking as a pill: "$✓ Pagada", "$½ Anticipo", "$ Por cobrar", "$! Debe". */
export function PaymentBadge({ appt }: { appt: Pick<AppointmentDto, 'priceCents' | 'paidCents' | 'status'> }) {
  const { t } = useTranslation();
  const state = paymentState(appt);
  if (state === 'free') return null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${PAYMENT_PILL[state]}`}>
      <span aria-hidden>{PAYMENT_PILL_TEXT[state]}</span>
      {t(`payState.${state}`)}
    </span>
  );
}

