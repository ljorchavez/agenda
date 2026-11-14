import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppointmentDto, AppointmentStatus, PaymentMethod } from '@agenda/shared';
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
  // fetch() failed: no internet
  if (error instanceof TypeError) msg = t('errors.network');
  if (error instanceof ApiError) {
    const key = ns ? `${ns}.${error.code}` : '';
    if (key && i18n.exists(key)) msg = t(key);
    else if (i18n.exists(`errors.${error.code}`)) msg = t(`errors.${error.code}`);
    else if (error.message && error.message !== error.code) msg = error.message;
  }
  return <p className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{msg}</p>;
}

/** Every page's title row: title (plus something small next to it) and the page's buttons. */
export function PageHeader({ title, actions, extra, tight, subtitle }: { title: string; actions?: ReactNode; extra?: ReactNode; tight?: boolean; subtitle?: ReactNode }) {
  return (
    <div className={tight ? 'mb-3' : 'mb-6'}>
      <div className="flex min-h-[2.5rem] flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
          {extra}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {subtitle && <p className="mt-1 max-w-2xl text-sm text-slate-500">{subtitle}</p>}
    </div>
  );
}

/**
 * The one way to switch sections of a page (Cobros, Punto de venta, Configuración): underlined
 * tabs under the title; on phones they slide sideways, on computers they wrap.
 */
export function PageTabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
  testIdPrefix,
}: {
  tabs: { id: K; label: string }[];
  value: K;
  onChange: (k: K) => void;
  label: string;
  testIdPrefix?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="-mx-1 mb-6 flex gap-1 overflow-x-auto overflow-y-hidden px-1 no-scrollbar shadow-[inset_0_-1px_0_0_#e2e8f0] md:flex-wrap md:overflow-visible">
      {tabs.map((x) => (
        <button
          key={x.id}
          role="tab"
          type="button"
          aria-selected={value === x.id}
          onClick={() => onChange(x.id)}
          className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${value === x.id ? 'border-brand-600 text-brand-800' : 'border-transparent text-slate-500 hover:text-slate-800'}`}
          data-testid={testIdPrefix ? `${testIdPrefix}${x.id}` : undefined}
        >
          {x.label}
        </button>
      ))}
    </div>
  );
}

/** Small on/off group of options (view, zoom…): one look everywhere. */
export function Segmented<K extends string>({ options, value, onChange, label }: { options: { id: K; label: ReactNode; title?: string }[]; value: K; onChange: (k: K) => void; label: string }) {
  return (
    <div className="inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white p-0.5" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={value === o.id}
          title={o.title}
          onClick={() => onChange(o.id)}
          className={`h-full rounded-md px-3 text-sm font-medium ${value === o.id ? 'bg-brand-700 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** "Nothing here yet" / "nothing matches": the same box on every list. */
export function Empty({ children, compact }: { children: ReactNode; compact?: boolean }) {
  return <div className={`rounded-xl border border-dashed border-slate-300 text-center text-slate-500 ${compact ? 'p-6 text-sm' : 'p-10'}`}>{children}</div>;
}

/** Long lists show the first few with a "See all" toggle instead of a box that scrolls inside the page. */
export function useShowMore<T>(rows: T[], first = 8, testId?: string) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, first);
  const toggle =
    rows.length > first ? (
      <button type="button" className="mt-2 text-sm font-medium text-brand-700 hover:underline" onClick={() => setAll(!all)} data-testid={testId}>
        {all ? t('common.showLess') : t('common.showAll', { count: rows.length })}
      </button>
    ) : null;
  return { shown, toggle };
}

export function Loading() {
  const { t } = useTranslation();
  return <div className="p-6 text-slate-500">{t('common.loading')}</div>;
}

/** Payment state of a booking as a pill: "$✓ Pagada", "$½ Anticipo", "$ Por cobrar", "$! Debe". */
export function PaymentBadge({
  appt,
  noShowOwes,
}: {
  appt: Pick<AppointmentDto, 'priceCents' | 'paidCents' | 'status'> & { endsAt?: string };
  noShowOwes?: boolean;
}) {
  const { t } = useTranslation();
  const state = paymentState(appt, { noShowOwes });
  if (state === 'free') return null;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ${PAYMENT_PILL[state]}`}>
      <span aria-hidden>{PAYMENT_PILL_TEXT[state]}</span>
      {t(`payState.${state}`)}
    </span>
  );
}


/**
 * A button that opens a small menu right below it (status chips, quick choices).
 * Closes on outside click, Escape or after choosing.
 */
export function MenuButton<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled,
  ariaLabel,
  align = 'right',
  testId,
}: {
  label: ReactNode;
  options: { value: T; label: ReactNode }[];
  value?: T;
  onChange: (v: T) => void;
  disabled?: boolean;
  ariaLabel: string;
  align?: 'left' | 'right';
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        data-testid={testId}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-0.5 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:cursor-default"
      >
        {label}
        {!disabled && <span aria-hidden className="text-[10px] text-slate-400">▾</span>}
      </button>
      {open && (
        <div role="menu" className={`absolute z-20 mt-1 min-w-[11rem] rounded-lg border border-slate-200 bg-white py-1 shadow-lg ${align === 'right' ? 'right-0' : 'left-0'}`}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={o.value === value}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-slate-50 ${o.value === value ? 'font-semibold text-slate-900' : 'text-slate-700'}`}
              onClick={() => {
                setOpen(false);
                if (o.value !== value) onChange(o.value);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** How a booking was paid, under its payment pill: "Mercado Pago · Efectivo". */
export function MethodTags({ methods }: { methods: PaymentMethod[] }) {
  const { t } = useTranslation();
  if (!methods.length) return null;
  return (
    <span className="inline-flex flex-wrap justify-end gap-1" data-testid="paid-methods">
      {methods.map((m) => (
        <span key={m} className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
          {t(`methods.${m}`)}
        </span>
      ))}
    </span>
  );
}

/** "1–50 de 312   ‹ ›" under a long list. */
export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const { t } = useTranslation();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <nav className="mt-3 flex items-center justify-end gap-2 text-sm text-slate-600" aria-label={t('pager.label')}>
      <span>{t('pager.range', { from, to, total })}</span>
      <button type="button" className="btn-secondary !px-2.5 !py-1" disabled={page === 0} onClick={() => onPage(page - 1)} aria-label={t('pager.prev')}>‹</button>
      <span className="tabular-nums">{page + 1} / {pages}</span>
      <button type="button" className="btn-secondary !px-2.5 !py-1" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label={t('pager.next')}>›</button>
    </nav>
  );
}

/** Shows a long, already loaded list one page at a time; goes back to page 1 when the list changes. */
export function usePaged<T>(rows: T[], size = 50) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [rows]);
  const last = Math.max(0, Math.ceil(rows.length / size) - 1);
  const p = Math.min(page, last);
  return {
    pageRows: rows.slice(p * size, (p + 1) * size),
    pager: <Pager page={p} pageSize={size} total={rows.length} onPage={setPage} />,
  };
}

/** On/off switch (a real checkbox underneath, so forms, keyboards and screen readers work). */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
  testId,
  className = '',
  hideLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** Text next to the switch; without it, used as the accessible name only */
  label?: ReactNode;
  testId?: string;
  className?: string;
  /** Keep the label for screen readers only */
  hideLabel?: boolean;
}) {
  return (
    <label className={`inline-flex items-center gap-2 ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${className}`} data-testid={testId}>
      <span className="relative inline-flex shrink-0">
        <input type="checkbox" role="switch" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={typeof label === 'string' ? label : undefined} />
        <span className="h-5 w-9 rounded-full bg-slate-300 transition-colors peer-checked:bg-brand-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-400 peer-focus-visible:ring-offset-1" />
        <span className="pointer-events-none absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
      </span>
      {label != null && !hideLabel && (typeof label === 'string' ? <span className="text-sm">{label}</span> : label)}
    </label>
  );
}
