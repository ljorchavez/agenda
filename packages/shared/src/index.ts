import { z } from 'zod';

// ---------- Enums ----------

/**
 * - owner: everything, including payment settings and logins
 * - admin: runs the business day to day (all bookings, team, catalog) but not payments or other admins
 * - staff: a team member ("colaborador") who only sees their own bookings, customers and numbers
 */
export const ROLES = ['owner', 'admin', 'staff'] as const;
export type Role = (typeof ROLES)[number];
/** Owners and admins see every booking and can change the catalog/team. */
export const isManager = (role: Role | null | undefined) => role === 'owner' || role === 'admin';
/** Roles a user may assign to others. */
export const assignableRoles = (role: Role): Role[] => (role === 'owner' ? ['owner', 'admin', 'staff'] : role === 'admin' ? ['staff'] : []);

export const BUSINESS_TYPES = [
  'nutrition',
  'medical',
  'cosmetology',
  'barbershop',
  'beauty_salon',
  'physiotherapy',
  'psychology',
  'dental',
  'spa',
  'veterinary',
  'restaurant',
  'cafe',
  'bar',
  'fitness',
  'yoga',
  'dance',
  'sports',
  'coworking',
  'studio',
  'other',
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** Directory groups: a few easy categories instead of 20 specific types. */
export const BUSINESS_CATEGORIES = ['health', 'beauty', 'food', 'classes', 'spaces', 'pets', 'other'] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];
export const CATEGORY_TYPES: Record<BusinessCategory, readonly BusinessType[]> = {
  health: ['medical', 'dental', 'nutrition', 'psychology', 'physiotherapy'],
  beauty: ['barbershop', 'beauty_salon', 'cosmetology', 'spa'],
  food: ['restaurant', 'cafe', 'bar'],
  classes: ['fitness', 'yoga', 'dance'],
  spaces: ['sports', 'coworking', 'studio'],
  pets: ['veterinary'],
  other: ['other'],
};
export const businessCategory = (t: BusinessType): BusinessCategory =>
  BUSINESS_CATEGORIES.find((c) => CATEGORY_TYPES[c].includes(t)) ?? 'other';

/**
 * How a business takes bookings:
 * - appointments: a service at a time slot (optionally with a professional)
 * - reservations: restaurant tables for a party size
 * - classes: group sessions with limited spots
 * - rentals: spaces (courts, rooms, studios) by the hour
 */
export const RESERVATION_TYPES: readonly BusinessType[] = ['restaurant', 'cafe', 'bar'];
export const CLASS_TYPES: readonly BusinessType[] = ['fitness', 'yoga', 'dance'];
export const RENTAL_TYPES: readonly BusinessType[] = ['sports', 'coworking', 'studio'];
export type BusinessKind = 'appointments' | 'reservations' | 'classes' | 'rentals';
export const businessKind = (t: BusinessType): BusinessKind =>
  RESERVATION_TYPES.includes(t)
    ? 'reservations'
    : CLASS_TYPES.includes(t)
      ? 'classes'
      : RENTAL_TYPES.includes(t)
        ? 'rentals'
        : 'appointments';

/**
 * Everything a business kind does differently lives here. The rest of the code (booking,
 * calendar, resources, reports) is shared by every kind and reads these flags.
 */
export interface KindConfig {
  /** Bookings carry a party size that must fit the resource capacity (restaurants) */
  partySize: boolean;
  /** Bookings are spots in group sessions (classes) */
  sessions: boolean;
  /** Customers pick a length instead of a service; price comes from the resource's hourly rate (rentals) */
  durations: boolean;
  /** A customer moving their booking keeps the same resource (their barber, their court); else any that fits */
  keepResourceOnReschedule: boolean;
}
export const KIND_CONFIG: Record<BusinessKind, KindConfig> = {
  appointments: { partySize: false, sessions: false, durations: false, keepResourceOnReschedule: true },
  reservations: { partySize: true, sessions: false, durations: false, keepResourceOnReschedule: false },
  classes: { partySize: false, sessions: true, durations: false, keepResourceOnReschedule: true },
  rentals: { partySize: false, sessions: false, durations: true, keepResourceOnReschedule: true },
};
export const kindConfig = (k: BusinessKind): KindConfig => KIND_CONFIG[k];

/** Colours offered for resources (people, spaces, tables) in the calendar. */
export const RESOURCE_COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#ca8a04', '#16a34a', '#475569'] as const;

/**
 * Resources that can take a booking: they do the service (an empty list means every service)
 * and fit the party (no capacity means no limit).
 */
export const eligibleResources = <T extends { serviceIds: string[]; capacity?: number | null }>(
  list: T[],
  opts: { serviceId?: string | null; partySize?: number | null } = {},
): T[] =>
  list.filter(
    (r) =>
      (!opts.serviceId || !r.serviceIds.length || r.serviceIds.includes(opts.serviceId)) &&
      (!opts.partySize || r.capacity == null || r.capacity >= opts.partySize),
  );

/** Price for `durationMin` at `pricePerHourCents`. */
export const hourlyPriceCents = (pricePerHourCents: number, durationMin: number) =>
  Math.round((pricePerHourCents * durationMin) / 60);

/** A booking costs the resource's hourly rate when it has one, otherwise the service price. */
export const bookingPriceCents = (
  resource: { pricePerHourCents: number | null } | null | undefined,
  servicePriceCents: number,
  durationMin: number,
) => (resource?.pricePerHourCents ? hourlyPriceCents(resource.pricePerHourCents, durationMin) : servicePriceCents);

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

// ---------- Payment settings (optional per business) ----------

export const DEPOSIT_TYPES = ['percent', 'fixed'] as const;
export type DepositType = (typeof DEPOSIT_TYPES)[number];

export const paymentSettingsSchema = z.object({
  /** Which methods the business accepts. Online methods need Mercado Pago connected. */
  methods: z.object({
    cash: z.boolean(),
    card: z.boolean(),
    transfer: z.boolean(),
    mercadopago: z.boolean(),
    spei: z.boolean(),
  }),
  /** Bank details shown to customers who pay by transfer. */
  transfer: z.object({
    bank: z.string().trim().max(80),
    accountHolder: z.string().trim().max(120),
    clabe: z
      .string()
      .trim()
      .refine((v) => v === '' || isValidClabe(v), 'invalid_clabe'),
  }),
  deposit: z.object({
    enabled: z.boolean(),
    type: z.enum(DEPOSIT_TYPES),
    /** Percent (1-100) when type = percent; cents when type = fixed. */
    value: z.number().int().min(0).max(100_000_000),
  }).refine((d) => d.type !== 'percent' || (d.value >= 1 && d.value <= 100), {
    message: 'percent_out_of_range',
    path: ['value'],
  }),
});
export type PaymentSettings = z.infer<typeof paymentSettingsSchema>;

export const DEFAULT_PAYMENT_SETTINGS: PaymentSettings = {
  methods: { cash: true, card: true, transfer: true, mercadopago: false, spei: false },
  transfer: { bank: '', accountHolder: '', clabe: '' },
  deposit: { enabled: false, type: 'percent', value: 50 },
};

/** Deposit amount in cents for a given price, or 0 when deposits are off. Never exceeds the price. */
export function computeDepositCents(priceCents: number, payments?: PaymentSettings | null): number {
  const d = payments?.deposit;
  if (!d?.enabled || priceCents <= 0) return 0;
  const raw = d.type === 'percent' ? Math.round((priceCents * d.value) / 100) : d.value;
  return Math.max(0, Math.min(raw, priceCents));
}

/** Settings stored before payments existed have no `payments` key. */
export function paymentSettingsOf(settings: { payments?: PaymentSettings }): PaymentSettings {
  return settings.payments ?? DEFAULT_PAYMENT_SETTINGS;
}

/** Validates a CLABE check digit (Mexican interbank account number). */
export function isValidClabe(clabe: string): boolean {
  if (!/^\d{18}$/.test(clabe)) return false;
  const w = [3, 7, 1];
  const sum = clabe
    .slice(0, 17)
    .split('')
    .reduce((acc, ch, i) => acc + ((Number(ch) * w[i % 3]!) % 10), 0);
  return (10 - (sum % 10)) % 10 === Number(clabe[17]);
}

export const tenantSettingsSchema = z.object({
  hours: businessHoursSchema,
  remindersEnabled: z.boolean(),
  /** Hours before the appointment to send the WhatsApp reminder */
  reminderHoursBefore: z.number().int().min(1).max(72),
  onlineBookingEnabled: z.boolean(),
  payments: paymentSettingsSchema.optional(),
  selfService: z
    .object({
      /** Customers can reschedule their own appointment from a private link */
      rescheduleEnabled: z.boolean(),
      /** Customers can cancel their own appointment from the same link */
      cancelEnabled: z.boolean(),
      /** Minimum notice (hours before the appointment) to change it online */
      minHoursNotice: z.number().int().min(0).max(168),
    })
    .optional(),
  reservations: z
    .object({
      /** How long a table is held for one reservation */
      durationMin: z.number().int().min(30).max(360),
      /** Largest party that can book online */
      maxPartySize: z.number().int().min(1).max(50),
    })
    .optional(),
  rentals: z
    .object({
      /** Booking lengths customers can choose, in minutes */
      durations: z.array(z.number().int().min(15).max(720)).min(1).max(8),
    })
    .optional(),
});
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;
export type ReservationSettings = NonNullable<TenantSettings['reservations']>;
export const DEFAULT_RESERVATION_SETTINGS: ReservationSettings = { durationMin: 90, maxPartySize: 8 };
export function reservationSettingsOf(settings: Pick<TenantSettings, 'reservations'> | null | undefined): ReservationSettings {
  return { ...DEFAULT_RESERVATION_SETTINGS, ...(settings?.reservations ?? {}) };
}
export type RentalSettings = NonNullable<TenantSettings['rentals']>;
export const DEFAULT_RENTAL_SETTINGS: RentalSettings = { durations: [60, 90, 120] };
export function rentalSettingsOf(settings: Pick<TenantSettings, 'rentals'> | null | undefined): RentalSettings {
  const d = settings?.rentals?.durations;
  return { durations: d && d.length ? [...d].sort((a, b) => a - b) : DEFAULT_RENTAL_SETTINGS.durations };
}
export type SelfServiceSettings = NonNullable<TenantSettings['selfService']>;

export const DEFAULT_SELF_SERVICE: SelfServiceSettings = {
  rescheduleEnabled: true,
  cancelEnabled: true,
  minHoursNotice: 24,
};

/** Self-service settings with defaults filled in (older tenants lack the key). */
export function selfServiceOf(settings: Pick<TenantSettings, 'selfService'> | null | undefined): SelfServiceSettings {
  return { ...DEFAULT_SELF_SERVICE, ...(settings?.selfService ?? {}) };
}

export const DEFAULT_TENANT_SETTINGS: TenantSettings = {
  hours: DEFAULT_BUSINESS_HOURS,
  remindersEnabled: true,
  reminderHoursBefore: 24,
  onlineBookingEnabled: true,
  payments: DEFAULT_PAYMENT_SETTINGS,
  selfService: DEFAULT_SELF_SERVICE,
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
  /** Plan chosen before creating the account */
  plan: z.enum(['free', 'standard']).default('free'),
});
export type RegisterInput = z.infer<typeof registerSchema>;

/** A logged-in owner opening another business (billed separately). */
export const businessCreateSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  businessType: z.enum(BUSINESS_TYPES),
  phone: phoneSchema.optional(),
});
export type BusinessCreateInput = z.infer<typeof businessCreateSchema>;

export const switchBusinessSchema = z.object({ tenantId: z.string().uuid() });

/** A business the logged-in person can open, with their role there. */
export interface BusinessSummary {
  id: string;
  name: string;
  slug: string;
  businessType: BusinessType;
  kind: BusinessKind;
  role: Role;
}

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
  profile: z.lazy(() => tenantProfileSchema).optional(),
});
export type TenantUpdateInput = z.infer<typeof tenantUpdateSchema>;

// ---------- Public profile & directory ----------

/** Public info shown on the booking page and (if listed) in the directory. */
export const tenantProfileSchema = z
  .object({
    description: z.string().trim().max(500).nullable(),
    address: z.string().trim().max(200).nullable(),
    neighborhood: z.string().trim().max(120).nullable(),
    city: z.string().trim().max(120).nullable(),
    state: z.string().trim().max(120).nullable(),
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    directoryListed: z.boolean(),
  })
  .refine((p) => (p.lat === null) === (p.lng === null), { message: 'lat_lng_pair', path: ['lat'] })
  .refine((p) => !p.directoryListed || (p.lat !== null && p.city), {
    message: 'directory_needs_location',
    path: ['directoryListed'],
  });
export type TenantProfile = z.infer<typeof tenantProfileSchema>;

export interface DirectoryEntryDto {
  slug: string;
  name: string;
  businessType: BusinessType;
  kind: BusinessKind;
  description: string | null;
  address: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  lat: number;
  lng: number;
  phone: string | null;
  onlineBooking: boolean;
  /** Lowest active service price (or space price per hour), for "desde $X" */
  priceFromCents: number | null;
  /** 'hour' when the price is per hour (space rentals) */
  priceUnit: 'hour' | null;
  /** One pin per location; null name when the business has a single location */
  locationId: string;
  locationName: string | null;
}

export interface DirectoryDto {
  entries: DirectoryEntryDto[];
  /** Zones present in the directory, for the filter */
  zones: { state: string; cities: string[] }[];
}

// ---------- Locations (sucursales) ----------

/**
 * Pricing model (see docs/billing.md): each business is billed on its own plan, which
 * includes this many locations; every extra active location is an add-on.
 */
export const PLAN_INCLUDED_LOCATIONS = 1;

// ---------- Subscription plans ----------
// Each business has its own plan. Prices are provisional and live only here.

export const PLANS = ['free', 'standard', 'premium'] as const;
export type PlanId = (typeof PLANS)[number];
/** Plans a customer can pick today (Premium is coming soon). */
export const SELECTABLE_PLANS: readonly PlanId[] = ['free', 'standard'];

export interface PlanLimits {
  /** null = unlimited */
  maxCustomers: number | null;
  /** Bookings created per calendar month; null = unlimited */
  maxBookingsPerMonth: number | null;
  /** Can add locations (each extra one is billed) */
  extraLocations: boolean;
  /** Can be one of several businesses of the same owner */
  extraBusinesses: boolean;
  /** Monthly price in cents (MXN, IVA incluido); null = to be defined */
  priceCents: number | null;
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: { maxCustomers: 5, maxBookingsPerMonth: null, extraLocations: false, extraBusinesses: false, priceCents: 0 },
  standard: { maxCustomers: null, maxBookingsPerMonth: 500, extraLocations: true, extraBusinesses: true, priceCents: 39_900 },
  premium: { maxCustomers: null, maxBookingsPerMonth: null, extraLocations: true, extraBusinesses: true, priceCents: null },
};

/** Add-ons, per month (MXN, IVA incluido). */
export const ADDON_PRICES = { extraLocationCents: 19_900, extraBusinessCents: 29_900 } as const;

export interface PlanUsage {
  customers: number;
  bookingsThisMonth: number;
  activeLocations: number;
}

export interface PlanInfoDto {
  plan: PlanId;
  limits: PlanLimits;
  usage: PlanUsage;
  /** Monthly total: plan + extra locations (+ extra business when it is not the owner's first) */
  monthlyTotalCents: number | null;
  extraLocations: number;
  /** This business is billed as an additional business of its owner */
  extraBusiness: boolean;
  /** Card payments for subscriptions are connected (otherwise plan changes apply without a charge) */
  billingConnected: boolean;
}

export const planChangeSchema = z.object({ plan: z.enum(PLANS) });

export const locationInputSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    phone: phoneSchema.nullable().optional(),
    address: z.string().trim().max(200).nullable().optional(),
    neighborhood: z.string().trim().max(120).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    state: z.string().trim().max(120).nullable().optional(),
    lat: z.number().min(-90).max(90).nullable().optional(),
    lng: z.number().min(-180).max(180).nullable().optional(),
    /** Null = same hours as the business */
    hours: businessHoursSchema.nullable().optional(),
    active: z.boolean().default(true),
  })
  .refine((p) => (p.lat == null) === (p.lng == null), { message: 'lat_lng_pair', path: ['lat'] });
export type LocationInput = z.infer<typeof locationInputSchema>;

export interface LocationDto {
  id: string;
  name: string;
  /** The first location; its address and hours come from the business profile/settings */
  isPrimary: boolean;
  phone: string | null;
  address: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  /** Own hours, or null when it uses the business hours */
  hours: BusinessHours | null;
  active: boolean;
}

/** What the customer sees when choosing a location (address/hours already resolved). */
export interface PublicLocationDto {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  hours: BusinessHours;
}

export interface PlanDto {
  includedLocations: number;
  activeLocations: number;
  extraLocations: number;
}

// ---------- Resources ----------
// Whatever gets booked: a person (barber, doctor, instructor), a space (court, room) or a table.
// They are one concept; KIND_CONFIG only decides how they are labelled and booked.

export const resourceInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#0f766e'),
  active: z.boolean().default(true),
  /** Services it takes; empty = all services */
  serviceIds: z.array(z.string().uuid()).max(200).default([]),
  /** Optional login linked to it (that person sees only its bookings) */
  userId: z.string().uuid().nullable().optional(),
  /** People that fit at once (table seats, court players); null = no limit */
  capacity: z.number().int().min(1).max(500).nullable().optional(),
  /** When set, bookings are priced by the hour instead of by the service */
  pricePerHourCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  description: z.string().trim().max(300).nullable().optional(),
  /** Location (sucursal); defaults to the main one */
  locationId: z.string().uuid().optional(),
});
export type ResourceInput = z.infer<typeof resourceInputSchema>;

export interface ResourceDto {
  id: string;
  name: string;
  color: string;
  active: boolean;
  serviceIds: string[];
  userId: string | null;
  capacity: number | null;
  pricePerHourCents: number | null;
  description: string | null;
  locationId: string;
}

// ---------- Group classes ----------

export const CLASS_SESSION_STATUSES = ['scheduled', 'cancelled'] as const;
export type ClassSessionStatus = (typeof CLASS_SESSION_STATUSES)[number];

export const classSessionInputSchema = z.object({
  /** The class type is a service (name, duration, price per spot) */
  serviceId: z.string().uuid(),
  /** Instructor */
  resourceId: z.string().uuid().nullable().optional(),
  startsAt: z.string().datetime({ offset: true }),
  durationMin: z.number().int().min(5).max(600).optional(),
  capacity: z.number().int().min(1).max(500),
  notes: z.string().trim().max(500).nullable().optional(),
  /** Skip the instructor double-booking check */
  allowOverlap: z.boolean().optional(),
  /** Location (sucursal); defaults to the main one */
  locationId: z.string().uuid().optional(),
});
export type ClassSessionInput = z.infer<typeof classSessionInputSchema>;

export const classSessionUpdateSchema = z.object({
  resourceId: z.string().uuid().nullable().optional(),
  startsAt: z.string().datetime({ offset: true }).optional(),
  durationMin: z.number().int().min(5).max(600).optional(),
  capacity: z.number().int().min(1).max(500).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
  allowOverlap: z.boolean().optional(),
});

export interface ClassSessionDto {
  id: string;
  serviceId: string;
  serviceName: string;
  resourceId: string | null;
  resourceName: string | null;
  resourceColor: string | null;
  startsAt: string;
  endsAt: string;
  capacity: number;
  /** Spots taken (not cancelled) */
  booked: number;
  status: ClassSessionStatus;
  priceCents: number;
  notes: string | null;
  locationId: string;
}

export interface PublicClassSessionDto {
  id: string;
  locationId: string;
  serviceId: string;
  serviceName: string;
  resourceName: string | null;
  startsAt: string;
  endsAt: string;
  capacity: number;
  spotsLeft: number;
  priceCents: number;
}

export const publicClassBookingSchema = z.object({
  classSessionId: z.string().uuid(),
  spots: z.number().int().min(1).max(10).default(1),
  name: z.string().trim().min(2).max(160),
  phone: phoneSchema,
  email: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
  notes: z.string().max(1000).optional(),
});
export type PublicClassBookingInput = z.infer<typeof publicClassBookingSchema>;

export const mercadoPagoConnectSchema = z.object({
  accessToken: z.string().trim().min(20).max(300),
});

export const staffCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  role: z.enum(ROLES).default('staff'),
  /** Resource (team member) this login belongs to (their agenda) */
  resourceId: z.string().uuid().nullable().optional(),
  /** Limit this login to one location (null = all locations) */
  locationId: z.string().uuid().nullable().optional(),
});
export type StaffCreateInput = z.infer<typeof staffCreateSchema>;

export const userUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  role: z.enum(ROLES).optional(),
  /** Sets a new password (owners/admins resetting a team member's access) */
  password: z.string().min(8).max(200).optional(),
  resourceId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().nullable().optional(),
});
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;

/** Anyone can rename themselves or change their own password (current one required). */
export const accountUpdateSchema = z
  .object({
    name: z.string().trim().min(2).max(120).optional(),
    currentPassword: z.string().max(200).optional(),
    newPassword: z.string().min(8).max(200).optional(),
  })
  .refine((x) => !x.newPassword || Boolean(x.currentPassword), { path: ['currentPassword'], message: 'currentPassword required' });
export type AccountUpdateInput = z.infer<typeof accountUpdateSchema>;

export interface UserDto {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Linked resource (team member), if any */
  resourceId: string | null;
  resourceName: string | null;
  /** Null = all locations */
  locationId: string | null;
  locationName: string | null;
  /** Also has access to other businesses (then only they can change their name/password) */
  sharedAccount: boolean;
}

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
  /** Required for services; rentals and classes infer it */
  serviceId: z.string().uuid().optional(),
  staffUserId: z.string().uuid().nullable().optional(),
  /** Required except for class sign-ups, which take the session's time */
  startsAt: z.string().datetime({ offset: true }).optional(),
  /** Overrides service duration if provided */
  durationMin: z.number().int().min(5).max(600).optional(),
  /** Overrides service price if provided */
  priceCents: z.number().int().min(0).optional(),
  notes: z.string().max(2000).nullable().optional(),
  /** Skip the double-booking check (e.g. businesses with several chairs) */
  allowOverlap: z.boolean().optional(),
  /** Number of people (must fit the resource capacity; class spots) */
  partySize: z.number().int().min(1).max(50).optional(),
  /** Who or what takes the booking; auto-assigned when omitted */
  resourceId: z.string().uuid().nullable().optional(),
  /** Classes: add the customer to this session (partySize = spots) */
  classSessionId: z.string().uuid().optional(),
  /** Location (sucursal); inferred from the resource/class, else the main one */
  locationId: z.string().uuid().optional(),
}).refine((x) => Boolean(x.startsAt || x.classSessionId), { path: ['startsAt'], message: 'startsAt required' });
export type AppointmentCreateInput = z.infer<typeof appointmentCreateSchema>;

export const appointmentUpdateSchema = z.object({
  startsAt: z.string().datetime({ offset: true }).optional(),
  durationMin: z.number().int().min(5).max(600).optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  priceCents: z.number().int().min(0).optional(),
  notes: z.string().max(2000).nullable().optional(),
  staffUserId: z.string().uuid().nullable().optional(),
  allowOverlap: z.boolean().optional(),
  partySize: z.number().int().min(1).max(50).optional(),
  resourceId: z.string().uuid().nullable().optional(),
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

/** One booking request for every kind (classes use publicClassBookingSchema). KIND_CONFIG says which fields apply. */
export const publicBookingSchema = z.object({
  locationId: z.string().uuid().optional(),
  /** Required unless the kind books by duration or party size */
  serviceId: z.string().uuid().optional(),
  /** Omit for "any available" */
  resourceId: z.string().uuid().nullable().optional(),
  /** Kinds with party size */
  partySize: z.number().int().min(1).max(50).optional(),
  /** Kinds that book by duration */
  durationMin: z.number().int().min(15).max(720).optional(),
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
  /** Resource linked to this login (staff only see its bookings) */
  resourceId: string | null;
  /** Location this login is limited to in the current business (null = all) */
  locationId: string | null;
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
  kind: BusinessKind;
  profile: TenantProfile;
  /** Never includes the token itself. */
  mercadoPago: { connected: boolean; account: string | null };
  plan: PlanId;
}

export interface AuthResponse {
  token: string;
  user: SessionUser;
  /** Every business this person can open */
  businesses: BusinessSummary[];
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
  locationId: string;
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
  /** Private customer link to reschedule/cancel: /c/<token> */
  managePath: string;
  /** People in the booking (party size, class spots) */
  partySize: number | null;
  resourceId: string | null;
  resourceName: string | null;
  resourceColor: string | null;
  classSessionId: string | null;
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

// ---------- Reports (historical, filterable) ----------

export const REPORT_GRANULARITIES = ['day', 'week', 'month'] as const;
export type ReportGranularity = (typeof REPORT_GRANULARITIES)[number];

export const reportQuerySchema = z
  .object({
    /** Local dates (tenant time zone), both inclusive */
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    granularity: z.enum(REPORT_GRANULARITIES).optional(),
    serviceId: z.string().uuid().optional(),
    staffUserId: z.string().uuid().optional(),
    resourceId: z.string().uuid().optional(),
    locationId: z.string().uuid().optional(),
    source: z.enum(APPOINTMENT_SOURCES).optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'from_after_to', path: ['from'] });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export interface ReportKpis {
  revenueCents: number;
  payments: number;
  avgTicketCents: number;
  appointments: number;
  completed: number;
  cancelled: number;
  noShows: number;
  noShowRate: number;
  cancellationRate: number;
  newCustomers: number;
  activeCustomers: number;
  returningCustomers: number;
  onlineShare: number;
}

export interface ReportPoint {
  /** Bucket start as local date YYYY-MM-DD */
  bucket: string;
  revenueCents: number;
  appointments: number;
  completed: number;
  noShows: number;
  cancelled: number;
  newCustomers: number;
}

export interface ReportDto {
  range: { from: string; to: string };
  previousRange: { from: string; to: string };
  granularity: ReportGranularity;
  kpis: ReportKpis;
  previousKpis: ReportKpis;
  series: ReportPoint[];
  previousSeries: ReportPoint[];
  byService: { id: string; name: string; count: number; revenueCents: number }[];
  /** Completed bookings per resource (person, space, table) */
  byResource: { id: string; name: string; color: string; count: number; revenueCents: number }[];
  /** Completed bookings per location (sucursal) */
  byLocation: { id: string; name: string; count: number; revenueCents: number }[];
  byMethod: { method: PaymentMethod; count: number; revenueCents: number }[];
  bySource: { source: AppointmentSource; count: number }[];
  byWeekday: { weekday: number; count: number }[];
  /** weekday 1-7 x local hour 0-23 */
  heatmap: { weekday: number; hour: number; count: number }[];
  topCustomers: { id: string; name: string; visits: number; totalSpentCents: number }[];
}

// ---------- Customer self-service (manage link) ----------

export const manageRescheduleSchema = z.object({ startsAt: z.string().datetime({ offset: true }) });

export interface ManageAppointmentDto {
  business: { name: string; slug: string; timezone: string; locale: Locale; phone: string | null; hours: BusinessHours; kind: BusinessKind };
  appointment: {
    id: string;
    serviceName: string;
    durationMin: number;
    startsAt: string;
    status: AppointmentStatus;
    customerFirstName: string;
    partySize: number | null;
    /** Resource name, if any */
    resourceName: string | null;
  };
  canReschedule: boolean;
  canCancel: boolean;
  /** Changes allowed until this instant; null when not allowed at all */
  changeDeadline: string | null;
  minHoursNotice: number;
  /** Why changes are not allowed, if they aren't */
  reason: null | 'disabled' | 'too_late' | 'not_active' | 'past';
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
  /** Present when the business requires a deposit to book online. */
  deposit: { type: DepositType; value: number } | null;
  kind: BusinessKind;
  description: string | null;
  address: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
  lat: number | null;
  lng: number | null;
  /** Restaurants: largest party bookable online */
  maxPartySize: number | null;
  /** Active resources (empty when the business works as a single agenda) */
  resources: Pick<ResourceDto, 'id' | 'name' | 'color' | 'serviceIds' | 'capacity' | 'pricePerHourCents' | 'description' | 'locationId'>[];
  /** Kinds that book by duration: the lengths offered */
  rentalDurations: number[] | null;
  /** Active locations; the booking page asks which one when there are several */
  locations: PublicLocationDto[];
}

export interface PublicBookingResult {
  id: string;
  startsAt: string;
  endsAt: string;
  serviceName: string;
  businessName: string;
  partySize: number | null;
  /** Resource assigned, if any */
  resourceName: string | null;
  /** Total price of the booking */
  priceCents: number;
  /** Private path (/c/<token>) where the customer can reschedule or cancel */
  managePath: string;
  deposit: null | {
    amountCents: number;
    /** Mercado Pago checkout (card) or SPEI instructions page */
    checkoutUrl: string | null;
    method: PaymentMethod | null;
    /** Bank transfer instructions when online payment is not available */
    transfer: { bank: string; accountHolder: string; clabe: string } | null;
  };
}

export interface ApiErrorBody {
  error: string;
  message?: string;
  details?: unknown;
}
