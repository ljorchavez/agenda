import { businessKind, paymentSettingsOf, reservationSettingsOf, selfServiceOf } from '@agenda/shared';
import { manageToken } from './crypto.js';
import type {
  AppointmentDto,
  CustomerDto,
  Locale,
  PaymentDto,
  ServiceDto,
  TenantDto,
} from '@agenda/shared';
import type { Customer, Payment, Service, Tenant } from '../db/schema.js';

const iso = (d: Date | string | null | undefined): string | null =>
  d == null ? null : new Date(d).toISOString();

export function toTenantDto(t: Tenant): TenantDto {
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    businessType: t.businessType,
    phone: t.phone,
    timezone: t.timezone,
    currency: t.currency,
    locale: t.locale as Locale,
    settings: {
      ...t.settings,
      payments: paymentSettingsOf(t.settings),
      selfService: selfServiceOf(t.settings),
      reservations: reservationSettingsOf(t.settings),
    },
    kind: businessKind(t.businessType),
    profile: {
      description: t.description,
      address: t.address,
      neighborhood: t.neighborhood,
      city: t.city,
      state: t.state,
      lat: t.lat,
      lng: t.lng,
      directoryListed: t.directoryListed,
    },
    mercadoPago: { connected: Boolean(t.mpAccessTokenEnc), account: t.mpAccount },
  };
}

export function toCustomerDto(c: Customer): CustomerDto {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    notes: c.notes,
    birthday: c.birthday,
    createdAt: iso(c.createdAt)!,
  };
}

export function toServiceDto(s: Service): ServiceDto {
  return {
    id: s.id,
    name: s.name,
    durationMin: s.durationMin,
    priceCents: s.priceCents,
    active: s.active,
  };
}

export function toPaymentDto(p: Payment & { customerName?: string }): PaymentDto {
  return {
    id: p.id,
    customerId: p.customerId,
    customerName: p.customerName,
    appointmentId: p.appointmentId,
    amountCents: p.amountCents,
    method: p.method,
    status: p.status,
    provider: p.provider,
    providerRef: p.providerRef,
    checkoutUrl: p.checkoutUrl,
    paidAt: iso(p.paidAt),
    createdAt: iso(p.createdAt)!,
    notes: p.notes,
  };
}

/** Row shape returned by the appointment list query (see routes/appointments.ts). */
export type AppointmentRow = {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  service_id: string;
  service_name: string;
  staff_user_id: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
  status: AppointmentDto['status'];
  price_cents: number;
  source: AppointmentDto['source'];
  notes: string | null;
  paid_cents: number | string | null;
  party_size: number | null;
  table_id: string | null;
  table_name: string | null;
};

export function toAppointmentDto(r: AppointmentRow): AppointmentDto {
  return {
    id: r.id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    serviceId: r.service_id,
    serviceName: r.service_name,
    staffUserId: r.staff_user_id,
    startsAt: iso(r.starts_at)!,
    endsAt: iso(r.ends_at)!,
    status: r.status,
    priceCents: Number(r.price_cents),
    source: r.source,
    notes: r.notes,
    paidCents: Number(r.paid_cents ?? 0),
    managePath: `/c/${manageToken(r.id)}`,
    partySize: r.party_size == null ? null : Number(r.party_size),
    tableId: r.table_id,
    tableName: r.table_name,
  };
}
