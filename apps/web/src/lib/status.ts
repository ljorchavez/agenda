import type { AppointmentDto, AppointmentStatus } from '@agenda/shared';

/**
 * Two separate states for every booking, so both are visible at a glance:
 * - booking: por confirmar / confirmada / asistió / no asistió / cancelada
 * - payment: sin costo / pagada / anticipo (parcial) / por cobrar / debe (ya pasó y falta dinero)
 */
export const BOOKING_ICON: Record<AppointmentStatus, string> = {
  scheduled: '◌',
  confirmed: '✓',
  completed: '✔',
  no_show: '✕',
  cancelled: '⊘',
};

export type PaymentState = 'free' | 'paid' | 'partial' | 'unpaid' | 'owed';

/**
 * - Fully paid → pagada. Cancelled or free → nothing to collect.
 * - Its time already passed (or it was marked attended) and money is missing → debe.
 * - A no-show owes too, unless the business chose not to charge no-shows.
 * - Still ahead: anticipo if something was paid, otherwise por cobrar.
 */
export function paymentState(
  a: Pick<AppointmentDto, 'priceCents' | 'paidCents' | 'status'> & { endsAt?: string },
  opts: { noShowOwes?: boolean; now?: Date } = {},
): PaymentState {
  if (a.status === 'cancelled') return a.paidCents > 0 ? 'paid' : 'free';
  if (a.priceCents <= 0) return a.paidCents > 0 ? 'paid' : 'free';
  if (a.paidCents >= a.priceCents) return 'paid';
  if (a.status === 'no_show') {
    if (opts.noShowOwes === false) return a.paidCents > 0 ? 'paid' : 'free';
    return 'owed';
  }
  const over = a.status === 'completed' || (a.endsAt != null && new Date(a.endsAt) <= (opts.now ?? new Date()));
  if (over) return 'owed';
  return a.paidCents > 0 ? 'partial' : 'unpaid';
}

/** Small "$" pill: green paid, amber deposit, grey to collect, red owed. */
export const PAYMENT_PILL: Record<Exclude<PaymentState, 'free'>, string> = {
  paid: 'bg-emerald-600 text-white',
  partial: 'bg-amber-400 text-amber-950',
  unpaid: 'border border-slate-400 bg-white text-slate-600',
  owed: 'bg-rose-600 text-white',
};

export const PAYMENT_PILL_TEXT: Record<Exclude<PaymentState, 'free'>, string> = {
  paid: '$✓',
  partial: '$½',
  unpaid: '$',
  owed: '$!',
};
