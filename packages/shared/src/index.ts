import { z } from 'zod';

// ---------- Enums ----------

export const ROLES = ['owner', 'staff'] as const;
export type Role = (typeof ROLES)[number];

export const BUSINESS_TYPES = [
  'nutrition',
  'medical',
  'cosmetology',
  'barbershop',
  'beauty_salon',
  'physiotherapy',
  'psychology',
  'dental',
  'other',
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const APPOINTMENT_STATUSES = [
  'scheduled',
  'confirmed',
  'completed',
  'cancelled',
  'no_show',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_SOURCES = ['staff', 'online'] as const;
export type AppointmentSource = (typeof APPOINTMENT_SOURCES)[number];

export const PAYMENT_METHODS = ['cash', 'card', 'transfer', 'mercadopago', 'spei'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['pending', 'paid', 'refunded', 'failed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const LOCALES = ['es', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

// ---------- Helpers ----------

/** E.164 phone, e.g. +5215512345678. Mexico numbers are normalized by `normalizeMxPhone`. */
const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{8,20}$/, 'invalid_phone');

/** True if the IANA time zone (e.g. America/Mexico_City) is known to the runtime. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'invalid_time');

/** Normalizes a Mexican phone to E.164 (+52XXXXXXXXXX). Leaves other country codes untouched. */
export function normalizeMxPhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  if (input.trim().startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+52${digits}`;
  if (digits.length === 12 && digits.startsWith('52')) return `+${digits}`;
  if (digits.length === 13 && digits.startsWith('521')) return `+52${digits.slice(3)}`;
  return `+${digits}`;
}

// ---------- Business settings ----------

export const businessHoursSchema = z.object({
  /** ISO weekdays the business is open: 1 = Monday ... 7 = Sunday */
  days: z.array(z.number().int().min(1).max(7)).min(1),
  open: timeSchema,
  close: timeSchema,
  /** Granularity of online booking slots, in minutes */
  slotMinutes: z.number().int().min(5).max(240),
});
export type BusinessHours = z.infer<typeof businessHoursSchema>;

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  days: [1, 2, 3, 4, 5, 6],
  open: '09:00',
  close: '19:00',
  slotMinutes: 30,
};

export const tenantSettingsSchema = z.object({
  hours: businessHoursSchema,
  remindersEnabled: z.boolean(),
  /** Hours before the appointment to send the WhatsApp reminder */
  reminderHoursBefore: z.number().int().min(1).max(72),
  onlineBookingEnabled: z.boolean(),
});
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

export const DEFAULT_TENANT_SETTINGS: TenantSettings = {
  hours: DEFAULT_BUSINESS_HOURS,
  remindersEnabled: true,
  reminderHoursBefore: 24,
  onlineBookingEnabled: true,
};

// ---------- Auth ----------

export const registerSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  businessType: z.enum(BUSINESS_TYPES),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  phone: phoneSchema.optional(),
  locale: z.enum(LOCALES).default('es'),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const tenantUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  businessType: z.enum(BUSINESS_TYPES).optional(),
  phone: phoneSchema.nullable().optional(),
  timezone: z.string().min(3).max(64).refine(isValidTimeZone, 'invalid_timezone').optional(),
  locale: z.enum(LOCALES).optional(),
  settings: tenantSettingsSchema.optional(),
});
export type TenantUpdateInput = z.infer<typeof tenantUpdateSchema>;

export const staffCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  role: z.enum(ROLES).default('staff'),
});
export type StaffCreateInput = z.infer<typeof staffCreateSchema>;

// ---------- Customers ----------

export const customerInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  phone: phoneSchema.nullable().optional(),
  email: z.string().trim().toLowerCase().email().nullable().optional().or(z.literal('')),
  notes: z.string().max(5000).nullable().optional(),
  birthday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});
export type CustomerInput = z.infer<typeof customerInputSchema>;

// ---------- Services ----------

export const serviceInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  durationMin: z.number().int().min(5).max(600),
  priceCents: z.number().int().min(0).max(100_000_000),
  active: z.boolean().default(true),
});
export type ServiceInput = z.infer<typeof serviceInputSchema>;

// ---------- Appointments ----------

export const appointmentCreateSchema = z.object({
  customerId: z.string().uuid(),
  serviceId: z.string().uuid(),
  staffUserId: z.string().uuid().nullable().optional(),
  startsAt: z.string().datetime({ offset: true }),
  /** Overrides service duration if provided */
  durationMin: z.number().int().min(5).max(600).optional(),
  /** Overrides service price if provided */
  priceCents: z.number().int().min(0).optional(),
  notes: z.string().max(2000).nullable().optional(),
  /** Skip the double-booking check (e.g. businesses with several chairs) */
  allowOverlap: z.boolean().optional(),
});
export type AppointmentCreateInput = z.infer<typeof appointmentCreateSchema>;

export const appointmentUpdateSchema = z.object({
  startsAt: z.string().datetime({ offset: true }).optional(),
  durationMin: z.number().int().min(5).max(600).optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  priceCents: z.number().int().min(0).optional(),
  notes: z.string().max(2000).nullable().optional(),
  staffUserId: z.string().uuid().nullable().optional(),
  allowOverlap: z.boolean().optional(),
  /**
   * When marking as completed, registers a paid payment for the outstanding balance
   * with this method in the same request.
   */
  paymentMethod: z.enum(['cash', 'card', 'transfer']).optional(),
});
export type AppointmentUpdateInput = z.infer<typeof appointmentUpdateSchema>;

export const appointmentListQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
});

// ---------- Payments ----------

export const paymentCreateSchema = z.object({
  customerId: z.string().uuid(),
  appointmentId: z.string().uuid().nullable().optional(),
  amountCents: z.number().int().min(1),
  method: z.enum(PAYMENT_METHODS),
  status: z.enum(PAYMENT_STATUSES).default('paid'),
  paidAt: z.string().datetime({ offset: true }).optional(),
  notes: z.string().max(1000).nullable().optional(),
});
export type PaymentCreateInput = z.infer<typeof paymentCreateSchema>;

export const paymentLinkSchema = z.object({
  appointmentId: z.string().uuid(),
  amountCents: z.number().int().min(100),
  method: z.enum(['mercadopago', 'spei']),
});
export type PaymentLinkInput = z.infer<typeof paymentLinkSchema>;

// ---------- Public booking ----------

export const publicBookingSchema = z.object({
  serviceId: z.string().uuid(),
  startsAt: z.string().datetime({ offset: true }),
  name: z.string().trim().min(2).max(160),
  phone: phoneSchema,
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  notes: z.string().max(1000).optional(),
});
export type PublicBookingInput = z.infer<typeof publicBookingSchema>;

// ---------- API response types ----------

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface TenantDto {
  id: string;
  name: string;
  slug: string;
  businessType: BusinessType;
  phone: string | null;
  timezone: string;
  currency: string;
  locale: Locale;
  settings: TenantSettings;
}

export interface AuthResponse {
  token: string;
  user: SessionUser;
  tenant: TenantDto;
}

export interface CustomerStats {
  visits: number;
  totalSpentCents: number;
  lastVisitAt: string | null;
  nextAppointmentAt: string | null;
  /** Average days between completed visits; null if fewer than 2 visits */
  avgDaysBetweenVisits: number | null;
  noShows: number;
}

export interface CustomerDto {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  birthday: string | null;
  createdAt: string;
}

export type CustomerWithStats = CustomerDto & CustomerStats;

export interface ServiceDto {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
  active: boolean;
}

export interface AppointmentDto {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  serviceId: string;
  serviceName: string;
  staffUserId: string | null;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  priceCents: number;
  source: AppointmentSource;
  notes: string | null;
  paidCents: number;
}

export interface PaymentDto {
  id: string;
  customerId: string;
  customerName?: string;
  appointmentId: string | null;
  amountCents: number;
  method: PaymentMethod;
  status: PaymentStatus;
  provider: string | null;
  providerRef: string | null;
  checkoutUrl: string | null;
  paidAt: string | null;
  createdAt: string;
  notes: string | null;
}

export interface DashboardDto {
  range: { from: string; to: string };
  kpis: {
    revenueCents: number;
    revenuePrevCents: number;
    appointments: number;
    completed: number;
    noShowRate: number;
    newCustomers: number;
    activeCustomers: number;
    avgTicketCents: number;
    avgDaysBetweenVisits: number | null;
  };
  revenueByMonth: { month: string; revenueCents: number; appointments: number }[];
  appointmentsByStatus: { status: AppointmentStatus; count: number }[];
  appointmentsByWeekday: { weekday: number; count: number }[];
  topCustomers: { id: string; name: string; visits: number; totalSpentCents: number }[];
  topServices: { id: string; name: string; count: number; revenueCents: number }[];
  upcoming: AppointmentDto[];
}

export interface PublicBusinessDto {
  name: string;
  slug: string;
  businessType: BusinessType;
  timezone: string;
  locale: Locale;
  phone: string | null;
  hours: BusinessHours;
  services: Pick<ServiceDto, 'id' | 'name' | 'durationMin' | 'priceCents'>[];
}

export interface ApiErrorBody {
  error: string;
  message?: string;
  details?: unknown;
}
