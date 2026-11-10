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

export function paymentState(a: Pick<AppointmentDto, 'priceCents' | 'paidCents' | 'status'>): PaymentState {
  if (a.priceCents <= 0) return a.paidCents > 0 ? 'paid' : 'free';
  if (a.paidCents >= a.priceCents) return 'paid';
  // After the visit (or a no-show) money still missing is a debt.
  if (a.status === 'completed' || a.status === 'no_show') return 'owed';
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
