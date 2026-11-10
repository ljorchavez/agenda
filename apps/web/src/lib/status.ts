import { collectionState, type AppointmentDto, type AppointmentStatus, type CollectionState } from '@agenda/shared';

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

/** Same rules as the Cobros page (shared collectionState), reduced to the pill shown on cards. */
export function paymentState(
  a: Pick<AppointmentDto, 'priceCents' | 'paidCents' | 'status'> & { endsAt?: string },
  opts: { noShowOwes?: boolean; now?: Date } = {},
): PaymentState {
  const st = collectionState(
    { priceCents: a.priceCents, paidCents: a.paidCents, status: a.status, endsAt: a.endsAt ?? new Date(8.64e15) },
    { noShowOwes: opts.noShowOwes !== false, now: opts.now },
  );
  switch (st) {
    case null:
      return 'free';
    case 'upcoming_paid':
    case 'past_paid':
      return 'paid';
    case 'upcoming_deposit':
      return 'partial';
    case 'upcoming_unpaid':
      return a.status === 'completed' ? 'owed' : 'unpaid';
    default:
      return 'owed';
  }
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

/** Badge per collection state (Cobros page), same colors as the calendar pills. */
export const COLLECTION_PILL: Record<CollectionState, { pill: Exclude<PaymentState, 'free'> }> = {
  upcoming_unpaid: { pill: 'unpaid' },
  upcoming_deposit: { pill: 'partial' },
  upcoming_paid: { pill: 'paid' },
  past_unpaid: { pill: 'owed' },
  past_partial: { pill: 'owed' },
  past_paid: { pill: 'paid' },
};

