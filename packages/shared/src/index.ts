import { z } from 'zod';
import { customClinicalTemplateSchema, professionalSchema, type Professional } from './clinical';
import { customerFiscalSchema, invoicingSettingsSchema, type CustomerFiscal, type FiscalDocDto, type InvoiceDto } from './invoicing';

export * from './clinical';

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
/** Health giros keep a clinical record (NOM-004; dental: NOM-013) and say "pacientes". */
export const isHealthType = (t: BusinessType | string | null | undefined): boolean => CATEGORY_TYPES.health.includes(t as BusinessType);
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

export const PAYMENT_METHODS = ['cash', 'card', 'transfer', 'mercadopago', 'spei', 'gift_card'] as const;
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

/** A pause inside the day (lunch, split shift): 14:00–16:00 */
export const breakSchema = z.object({ start: timeSchema, end: timeSchema });
export type HoursBreak = z.infer<typeof breakSchema>;

export const businessHoursSchema = z.object({
  /** ISO weekdays the business is open: 1 = Monday ... 7 = Sunday */
  days: z.array(z.number().int().min(1).max(7)).min(1),
  open: timeSchema,
  close: timeSchema,
  /** Granularity of online booking slots, in minutes */
  slotMinutes: z.number().int().min(5).max(240),
  /** Closed stretches inside the day ("8 a 2 y 4 a 6" = open 8–18 with a 14–16 break) */
  breaks: z.array(breakSchema).max(4).optional(),
});
export type BusinessHours = z.infer<typeof businessHoursSchema>;

/** Working hours of one person/space: Mario Mon–Sat 8–17, Ramiro Tue–Sun 10–20. */
export const workHoursSchema = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1),
  open: timeSchema,
  close: timeSchema,
  breaks: z.array(breakSchema).max(4).optional(),
});
export type WorkHours = z.infer<typeof workHoursSchema>;

const hhmmToMin = (t: string) => {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/**
 * Open stretches of a day in minutes from midnight, breaks removed. A close at or before the
 * opening time means "until midnight". [[480, 840], [960, 1080]] = 8–14 and 16–18.
 */
export function openIntervals(h: { open: string; close: string; breaks?: HoursBreak[] }): [number, number][] {
  const open = hhmmToMin(h.open);
  const closeRaw = hhmmToMin(h.close);
  const close = closeRaw <= open ? 24 * 60 : closeRaw;
  let out: [number, number][] = [[open, close]];
  const breaks = [...(h.breaks ?? [])]
    .map((b) => [hhmmToMin(b.start), hhmmToMin(b.end)] as [number, number])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  for (const [bs, be] of breaks) {
    out = out.flatMap(([s, e]): [number, number][] => {
      if (be <= s || bs >= e) return [[s, e]];
      const parts: [number, number][] = [];
      if (bs > s) parts.push([s, bs]);
      if (be < e) parts.push([be, e]);
      return parts;
    });
  }
  return out;
}

/** Open stretches on an ISO weekday (1 = Monday), or [] when closed that day. */
export const intervalsOnWeekday = (h: { days: number[]; open: string; close: string; breaks?: HoursBreak[] }, weekday: number) =>
  h.days.includes(weekday) ? openIntervals(h) : [];

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
  /** A no-show still owes the booking (default) or is not charged. */
  noShowOwes: z.boolean().optional(),
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

/** Whether a customer who didn't show up still owes the booking (business setting; yes by default). */
export const noShowOwes = (settings: { payments?: PaymentSettings }) => paymentSettingsOf(settings).noShowOwes !== false;

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

const httpsUrl = z.string().trim().url().max(500).refine((u) => u.startsWith('https://'), 'https_only');
/** A social handle or link: "@barberia", "barberia" or a full https link. */
const handle = z.string().trim().max(120).nullable().optional();
/** How the public booking page looks: banner, profile picture, gallery, social links, notice. */
export const pageSettingsSchema = z.object({
  bannerUrl: httpsUrl.nullable().optional(),
  logoUrl: httpsUrl.nullable().optional(),
  gallery: z.array(httpsUrl).max(8).optional(),
  instagram: handle,
  facebook: handle,
  tiktok: handle,
  /** Short highlighted message ("Cerramos el 24 de diciembre") */
  notice: z.string().trim().max(200).nullable().optional(),
});
export type PageSettings = z.infer<typeof pageSettingsSchema>;
export const pageSettingsOf = (settings: { page?: PageSettings } | null | undefined): Required<Pick<PageSettings, 'gallery'>> & PageSettings => ({
  gallery: [],
  ...(settings?.page ?? {}),
});
/** Turns "@barberia" / "barberia" / a link into a link for that network. */
export function socialUrl(network: 'instagram' | 'facebook' | 'tiktok', value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  if (/^https:\/\//.test(v)) return v;
  const h = v.replace(/^@/, '').replace(/[^\w.\-]/g, '');
  if (!h) return null;
  return network === 'instagram' ? `https://instagram.com/${h}` : network === 'facebook' ? `https://facebook.com/${h}` : `https://tiktok.com/@${h}`;
}

/** "Every 6th visit gets 10% off": counts completed visits since the last reward. */
export const rewardSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Visits needed; the next booking after them gets the discount */
  everyVisits: z.number().int().min(2).max(50),
  discountType: z.enum(['percent', 'amount']),
  /** Percent (1–100) or cents */
  value: z.number().int().min(1),
});
export type RewardSettings = z.infer<typeof rewardSettingsSchema>;
export const DEFAULT_REWARDS: RewardSettings = { enabled: false, everyVisits: 5, discountType: 'percent', value: 10 };
export const rewardSettingsOf = (s: { rewards?: RewardSettings } | null | undefined): RewardSettings => ({ ...DEFAULT_REWARDS, ...(s?.rewards ?? {}) });
export const couponsEnabled = (s: { coupons?: { enabled: boolean } } | null | undefined) => Boolean(s?.coupons?.enabled);

/** Cents taken off `priceCents` (never more than the price). */
export function discountCents(priceCents: number, d: { discountType: 'percent' | 'amount'; value: number }): number {
  if (priceCents <= 0) return 0;
  const off = d.discountType === 'percent' ? Math.round((priceCents * Math.min(d.value, 100)) / 100) : d.value;
  return Math.max(0, Math.min(priceCents, off));
}

export const couponInputSchema = z.object({
  code: z.string().trim().min(3).max(30).regex(/^[A-Za-z0-9_-]+$/, 'code_format').transform((c) => c.toUpperCase()),
  discountType: z.enum(['percent', 'amount']),
  value: z.number().int().min(1),
  active: z.boolean().default(true),
  maxUses: z.number().int().min(1).nullable().optional(),
  validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /** Only for these services (empty = every service) */
  serviceIds: z.array(z.string().uuid()).max(200).default([]),
  /** Uses per customer (null = no limit); new coupons default to once */
  maxUsesPerCustomer: z.number().int().min(1).max(100).nullable().default(1),
}).refine((c) => c.discountType !== 'percent' || c.value <= 100, { path: ['value'], message: 'percent_max' });
export type CouponInput = z.infer<typeof couponInputSchema>;
export interface CouponDto {
  id: string;
  code: string;
  discountType: 'percent' | 'amount';
  value: number;
  active: boolean;
  maxUses: number | null;
  validUntil: string | null;
  serviceIds: string[];
  maxUsesPerCustomer: number | null;
  /** Bookings (not cancelled) that used it */
  uses: number;
}
/** What a booking would get off: the best of the reward and the coupon (they don't add up). */
export interface DiscountPreviewDto {
  discountCents: number;
  reason: 'reward' | 'coupon' | 'package' | null;
  couponCode: string | null;
  /** Coupon typed but not valid: 'coupon_invalid' | 'coupon_expired' | 'coupon_used_up' */
  couponError: string | null;
  reward: { enabled: boolean; everyVisits: number; visitsSince: number; eligible: boolean } | null;
}

export const tenantSettingsSchema = z.object({
  page: pageSettingsSchema.optional(),
  rewards: rewardSettingsSchema.optional(),
  coupons: z.object({ enabled: z.boolean() }).optional(),
  hours: businessHoursSchema,
  remindersEnabled: z.boolean(),
  /** Hours before the appointment to send the reminder (WhatsApp and email) */
  reminderHoursBefore: z.number().int().min(1).max(72),
  /** Email the customer when a booking is made, moved or cancelled (default on) */
  emailConfirmations: z.boolean().optional(),
  /** Also confirm by WhatsApp (each message has a cost from Meta; off by default) */
  whatsappConfirmations: z.boolean().optional(),
  /** Health giros: the business's own clinical-record templates */
  clinicalTemplates: z.array(customClinicalTemplateSchema).max(30).optional(),
  /** Electronic invoicing (CFDI) with Facturapi */
  invoicing: invoicingSettingsSchema.optional(),
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
  /** Selling packages, memberships and gift cards on the booking page (paid with the business's Mercado Pago) */
  sales: z
    .object({
      online: z.boolean(),
      /** Gift card amounts offered online, in cents (none = no gift cards online) */
      giftCardAmounts: z.array(z.number().int().min(10_000).max(5_000_000)).max(6).default([]),
    })
    .optional(),
  /** Health businesses: data printed on clinical documents */
  clinic: z
    .object({
      legalName: z.string().trim().max(200).nullable().optional(),
      /** Aviso de funcionamiento / licencia sanitaria */
      healthLicense: z.string().trim().max(100).nullable().optional(),
    })
    .optional(),
  /** Verified reviews on the booking page and the directory (default: shown) */
  reviews: z.object({ public: z.boolean() }).optional(),
  /** Who gets a booking made with "Cualquiera disponible" */
  assignment: z
    .object({
      strategy: z.enum(['least_used', 'cheapest', 'preferred']),
      /** For 'preferred': people/spaces in order of preference (the rest go after, least used first) */
      preferredIds: z.array(z.string().uuid()).max(200).default([]),
    })
    .optional(),
});
/** Reviews are shown publicly only from this many on (one bad first review doesn't define a business). */
export const MIN_PUBLIC_REVIEWS = 3;
export const reviewsArePublic = (settings: { reviews?: { public?: boolean } } | null | undefined) => settings?.reviews?.public !== false;
export type SalesSettings = { online: boolean; giftCardAmounts: number[] };
export const DEFAULT_GIFT_CARD_AMOUNTS = [50_000, 100_000, 150_000];
export function salesSettingsOf(settings: { sales?: Partial<SalesSettings> } | null | undefined): SalesSettings {
  return { online: settings?.sales?.online ?? false, giftCardAmounts: settings?.sales?.giftCardAmounts ?? DEFAULT_GIFT_CARD_AMOUNTS };
}
export type AssignmentSettings = { strategy: 'least_used' | 'cheapest' | 'preferred'; preferredIds: string[] };
export const ASSIGNMENT_STRATEGIES = ['least_used', 'cheapest', 'preferred'] as const;
export function assignmentSettingsOf(settings: { assignment?: Partial<AssignmentSettings> } | null | undefined): AssignmentSettings {
  return { strategy: settings?.assignment?.strategy ?? 'least_used', preferredIds: settings?.assignment?.preferredIds ?? [] };
}
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
  /** Not needed when signing up with Google */
  password: z.string().min(8).max(200).optional(),
  /** Google ID token ("Continuar con Google"); its email wins over `email` */
  googleCredential: z.string().min(20).max(4000).optional(),
  phone: phoneSchema.optional(),
  locale: z.enum(LOCALES).default('es'),
  /** Plan chosen before creating the account */
  plan: z.lazy(() => z.enum(PLANS)).default('free'),
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
/** "Continuar con Google": the ID token from Google Identity Services */
export const googleLoginSchema = z.object({ credential: z.string().min(20).max(4000) });
/** Public settings the app needs before login */
export interface PublicConfigDto {
  /** Set when GOOGLE_CLIENT_ID is configured; otherwise the Google button is hidden */
  googleClientId: string | null;
  /** Cloudflare Turnstile site key; when set, sign-up and public forms show the anti-bot check */
  turnstileSiteKey: string | null;
}

// ---------- Two-step sign-in (TOTP) ----------

/** Login answered with "now the 6-digit code" instead of a session. */
export interface MfaChallengeDto {
  mfaRequired: true;
  /** Short-lived ticket that proves the password (or Google) step passed */
  mfaToken: string;
}
export const mfaLoginSchema = z.object({
  mfaToken: z.string().min(20).max(2000),
  /** 6-digit code from the authenticator app, or a recovery code (xxxx-xxxx) */
  code: z.string().trim().min(6).max(20),
});
export interface TotpSetupDto {
  /** Base32 secret, for typing it by hand */
  secret: string;
  /** otpauth:// link (opens the authenticator app on a phone; also drawn as a QR) */
  otpauthUrl: string;
}
export const totpEnableSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/) });
export const totpDisableSchema = z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(20) });

/** Deleting a business for good: the owner types its name and their password. */
export const tenantDeleteSchema = z.object({ password: z.string().min(1).max(200), confirmName: z.string().trim().min(1).max(200) });

/** Browser error report (lib/monitor on the web). */
export const clientErrorSchema = z.object({
  message: z.string().max(1000),
  stack: z.string().max(8000).nullable().optional(),
  path: z.string().max(500).nullable().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** "Forgot my password": always answers ok, whether or not the email has an account. */
export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  locale: z.enum(LOCALES).default('es'),
});
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

/** New password from the link sent by email. */
export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(8).max(200),
});
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

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
  /** Verified reviews (hidden ones don't count) */
  ratingAverage: number | null;
  ratingCount: number;
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

export const PLANS = ['free', 'individual', 'standard', 'premium'] as const;
export type PlanId = (typeof PLANS)[number];
/** Plans a customer can pick today. */
export const SELECTABLE_PLANS: readonly PlanId[] = ['free', 'individual', 'standard', 'premium'];

export interface PlanLimits {
  /** null = unlimited */
  maxCustomers: number | null;
  /** Bookings created per calendar month; null = unlimited */
  maxBookingsPerMonth: number | null;
  /** Can add locations (each extra one is billed) */
  extraLocations: boolean;
  /** Can be one of several businesses of the same owner */
  extraBusinesses: boolean;
  /** Monthly price in cents (MXN, before IVA: shown "+ IVA"); null = to be defined */
  priceCents: number | null;
  /** Locations included in the price (extra active ones are an add-on when allowed) */
  includedLocations: number;
  /** Active people/spaces/tables per business; null = unlimited */
  maxResources: number | null;
  /** Support answered first */
  prioritySupport: boolean;
  /** Packages, memberships and gift cards */
  packages: boolean;
  /** Client record (allergies, notes, photos) */
  records: boolean;
  /** Commissions and cash closings */
  cash: boolean;
  /** Storage for record photos, in MB (0 = no photos) */
  recordPhotosMb: number;
}

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  // Reviews and the calendar link are in every plan.
  free: { maxCustomers: 5, maxBookingsPerMonth: null, extraLocations: false, extraBusinesses: false, priceCents: 0, includedLocations: 1, maxResources: null, prioritySupport: false, packages: false, records: false, cash: false, recordPhotosMb: 0 },
  // One professional (or one court/room): everything in Estándar for a single agenda.
  individual: { maxCustomers: null, maxBookingsPerMonth: 500, extraLocations: false, extraBusinesses: true, priceCents: 24_900, includedLocations: 1, maxResources: 1, prioritySupport: false, packages: true, records: true, cash: true, recordPhotosMb: 1024 },
  standard: { maxCustomers: null, maxBookingsPerMonth: 500, extraLocations: true, extraBusinesses: true, priceCents: 39_900, includedLocations: 1, maxResources: null, prioritySupport: false, packages: true, records: true, cash: true, recordPhotosMb: 1024 },
  premium: { maxCustomers: null, maxBookingsPerMonth: null, extraLocations: true, extraBusinesses: true, priceCents: 79_900, includedLocations: 2, maxResources: null, prioritySupport: true, packages: true, records: true, cash: true, recordPhotosMb: 10240 },
};

/** Add-ons, per month (MXN, + IVA). */
export const ADDON_PRICES = { extraLocationCents: 19_900, extraBusinessCents: 29_900 } as const;

export interface PlanUsage {
  customers: number;
  /** Active people/spaces/tables */
  activeResources: number;
  bookingsThisMonth: number;
  activeLocations: number;
  /** Record photos stored, in MB */
  recordPhotosMb: number;
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
  /** Subscription state at the provider */
  billing: {
    status: BillingStatus;
    /** Plan paid for but not confirmed yet */
    pendingPlan: PlanId | null;
    /** What the card is charged each month (IVA included) */
    amountCents: number | null;
    pastDueSince: string | null;
    readOnly: boolean;
  };
}

export const planChangeSchema = z.object({ plan: z.enum(PLANS) });

/** none: never subscribed or free · pending: waiting for the card · active · past_due: a charge failed · cancelled */
export const BILLING_STATUSES = ['none', 'pending', 'active', 'past_due', 'cancelled'] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];
/** Days a business keeps working normally after a failed charge before it turns read-only. */
export const BILLING_GRACE_DAYS = 7;
/** IVA added to plan prices when charging the card. */
export const PLAN_IVA = 0.16;
/** Monthly charge with IVA, in cents. */
export const withIva = (cents: number) => Math.round(cents * (1 + PLAN_IVA));

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

/** Photos are uploaded through /api/uploads and stored in Vercel Blob; only https links are kept. */
export const photoUrlSchema = z.string().trim().url().max(500).refine((u) => u.startsWith('https://'), 'https_only');

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
  /** Own working hours; null = the hours of its location */
  hours: workHoursSchema.nullable().optional(),
  photoUrl: photoUrlSchema.nullable().optional(),
  /** Commission: general percent and per-service percents that replace it */
  commissionPct: z.number().min(0).max(100).nullable().optional(),
  commissionByService: z.record(z.string().uuid(), z.number().min(0).max(100)).optional(),
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
  /** Own working hours; null = the hours of its location */
  hours: WorkHours | null;
  photoUrl: string | null;
  commissionPct: number | null;
  commissionByService: Record<string, number>;
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
  couponCode: z.string().trim().max(30).optional(),
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
    /** Health professionals: cédula, institution, specialty */
    professional: professionalSchema.optional(),
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
  /** Patient data for the clinical record (health businesses) */
  sex: z.enum(['F', 'M', 'X']).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  curp: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}\d{6}[HMX][A-Z]{5}[A-Z0-9]\d$/, 'curp_format')
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  /** Data to invoice them (CFDI 4.0); null removes it */
  fiscal: customerFiscalSchema.nullable().optional(),
  /** Archived customers are hidden from lists (records kept 5 years) */
  archived: z.boolean().optional(),
});
export type CustomerInput = z.infer<typeof customerInputSchema>;

// ---------- Services ----------

export const serviceInputSchema = z.object({
  name: z.string().trim().min(1).max(160),
  durationMin: z.number().int().min(5).max(600),
  priceCents: z.number().int().min(0).max(100_000_000),
  active: z.boolean().default(true),
  photoUrl: photoUrlSchema.nullable().optional(),
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
  /** Discount code; the loyalty reward applies by itself */
  couponCode: z.string().trim().max(30).optional(),
}).refine((x) => Boolean(x.startsAt || x.classSessionId), { path: ['startsAt'], message: 'startsAt required' });
export type AppointmentCreateInput = z.infer<typeof appointmentCreateSchema>;

/** Is a time free before saving? Answers with other free spaces/people and nearby free times. */
export const availabilityCheckSchema = z.object({
  serviceId: z.string().uuid().optional(),
  startsAt: z.string().datetime({ offset: true }),
  durationMin: z.number().int().min(5).max(600).optional(),
  partySize: z.number().int().min(1).max(50).optional(),
  resourceId: z.string().uuid().nullable().optional(),
  locationId: z.string().uuid().optional(),
  staffUserId: z.string().uuid().nullable().optional(),
});
export interface AvailabilityCheckDto {
  free: boolean;
  /** Why it's taken: 'overlap' | 'resource_busy' | 'blocked' | 'no_resource_available' | ... */
  reason: string | null;
  /** Other resources free at the same time (when a specific one was asked for) */
  freeResources: { id: string; name: string }[];
  /** Nearby start times that are free with the same choice, ISO */
  times: string[];
}

export const appointmentUpdateSchema = z.object({
  startsAt: z.string().datetime({ offset: true }).optional(),
  durationMin: z.number().int().min(5).max(600).optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  priceCents: z.number().int().min(0).optional(),
  notes: z.string().max(2000).nullable().optional(),
  /** Internal 1–5 rating of the visit; null clears it */
  rating: z.number().int().min(1).max(5).nullable().optional(),
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

// ---------- Blocked times ----------

/** Nobody can book in [startsAt, endsAt): the whole business, one location or one resource. */
export const timeBlockInputSchema = z
  .object({
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
    /** Both empty = the whole business */
    locationId: z.string().uuid().nullable().optional(),
    resourceId: z.string().uuid().nullable().optional(),
    reason: z.string().trim().max(200).nullable().optional(),
  })
  .refine((x) => new Date(x.endsAt) > new Date(x.startsAt), { path: ['endsAt'], message: 'ends_before_start' })
  .refine((x) => new Date(x.endsAt).getTime() - new Date(x.startsAt).getTime() <= 366 * 86_400_000, { path: ['endsAt'], message: 'range_too_long' });
export type TimeBlockInput = z.infer<typeof timeBlockInputSchema>;

export interface TimeBlockDto {
  id: string;
  startsAt: string;
  endsAt: string;
  locationId: string | null;
  resourceId: string | null;
  reason: string | null;
}

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

/** Methods processed by the platform (Mercado Pago, including SPEI through it); never entered by hand. */
export const ONLINE_METHODS = ['mercadopago', 'spei'] as const;
/** Methods the business records itself when money changes hands in person. */
export const MANUAL_METHODS = ['cash', 'card', 'transfer'] as const;

// ---------- Collections (cobros): every booking with its money state ----------

/**
 * Where a booking stands money-wise. "Before" = its time hasn't ended yet; "after" = it has.
 * A no-show counts as after; cancelled or free bookings have nothing to collect.
 */
export const COLLECTION_STATES = [
  'upcoming_unpaid',
  'upcoming_deposit',
  'upcoming_paid',
  'past_unpaid',
  'past_partial',
  'past_paid',
] as const;
export type CollectionState = (typeof COLLECTION_STATES)[number];
/** The ones still owing money after their time */
export const OWED_STATES: readonly CollectionState[] = ['past_unpaid', 'past_partial'];

export function collectionState(
  a: { priceCents: number; paidCents: number; status: AppointmentStatus; endsAt: string | Date },
  opts: { noShowOwes: boolean; now?: Date },
): CollectionState | null {
  if (a.status === 'cancelled' && a.paidCents <= 0) return null;
  const past = a.status === 'completed' || a.status === 'no_show' || new Date(a.endsAt) <= (opts.now ?? new Date());
  // What's due: a no-show that isn't charged only "owes" what it already paid.
  const due = a.status === 'cancelled' || (a.status === 'no_show' && !opts.noShowOwes) ? a.paidCents : a.priceCents;
  if (due <= 0 && a.paidCents <= 0) return null;
  if (a.paidCents >= due) return past ? 'past_paid' : 'upcoming_paid';
  if (a.paidCents > 0) return past ? 'past_partial' : 'upcoming_deposit';
  return past ? 'past_unpaid' : 'upcoming_unpaid';
}

export interface CollectionDto {
  appointmentId: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  serviceName: string | null;
  resourceName: string | null;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  priceCents: number;
  paidCents: number;
  /** What's still to collect (0 when paid or not charged) */
  balanceCents: number;
  state: CollectionState;
  /** Methods of the payments it already has */
  methods: PaymentMethod[];
  lastPaidAt: string | null;
  tenantId: string;
  businessName: string;
  locationId: string;
  locationName: string | null;
}

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
  couponCode: z.string().trim().max(30).optional(),
  /** Answers to the questionnaires of the chosen service */
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
  /** Cédula, institution and specialty shown on clinical documents */
  professional: Professional | null;
  /** Two-step sign-in is on */
  twoFactor: boolean;
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
  /** Card subscription state; `readOnly` when a failed charge went past the grace period */
  billing: { status: BillingStatus; readOnly: boolean; pastDueSince: string | null };
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
  /** Average of the internal 1–5 ratings of their bookings (null = never rated) */
  avgRating: number | null;
  ratingCount: number;
}

export interface CustomerDto {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  birthday: string | null;
  sex: 'F' | 'M' | 'X' | null;
  address: string | null;
  curp: string | null;
  /** Fiscal data for CFDI invoices */
  fiscal?: CustomerFiscal | null;
  /** Their Constancia de Situación Fiscal, if uploaded */
  fiscalDoc?: FiscalDocDto | null;
  archived: boolean;
  createdAt: string;
}

export type CustomerWithStats = CustomerDto & CustomerStats;

export interface ServiceDto {
  id: string;
  name: string;
  durationMin: number;
  priceCents: number;
  active: boolean;
  photoUrl: string | null;
}

export interface AppointmentDto {
  /** Taken off the price already (priceCents is what's charged) */
  discountCents: number;
  discountReason: 'reward' | 'coupon' | 'package' | null;
  couponCode: string | null;
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
  /** Internal 1–5 rating of the visit */
  rating: number | null;
  paidCents: number;
  /** Methods of the paid payments (e.g. ['mercadopago', 'cash'] for a deposit settled in person) */
  paidMethods: PaymentMethod[];
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
  /** Business it belongs to (useful when listing every business at once) */
  tenantId?: string;
  businessName?: string;
  /** Location of the booking it pays; null when it isn't tied to a booking */
  locationId?: string | null;
  locationName?: string | null;
  serviceName?: string | null;
  /** Counter sale (POS) it belongs to */
  saleId?: string | null;
  /** Its CFDI, if one was issued (canceled ones excluded) */
  invoice?: Pick<InvoiceDto, 'id' | 'uuid' | 'series' | 'folio' | 'status' | 'test'> | null;
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
  /** Part of revenue from selling packages, memberships, gift cards and counter sales (no booking) */
  salesCents: number;
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
  /** Counter sales (POS); null when the business doesn't sell products or a booking filter is on */
  pos: PosReport | null;
}

export interface PosKpis {
  sales: number;
  revenueCents: number;
  avgTicketCents: number;
  units: number;
  /** Revenue minus the products' cost (only lines whose product has a cost) */
  profitCents: number;
  /** Share of product revenue that has a cost, to judge the profit figure */
  costCoverage: number;
}

export interface PosReport {
  kpis: PosKpis;
  previousKpis: PosKpis;
  series: { bucket: string; revenueCents: number; sales: number }[];
  previousSeries: { bucket: string; revenueCents: number; sales: number }[];
  topProducts: { productId: string | null; name: string; units: number; revenueCents: number; profitCents: number | null }[];
  byCategory: { category: string | null; units: number; revenueCents: number }[];
  byMethod: { method: PaymentMethod; revenueCents: number }[];
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
  /** Completed visit: link to leave (or see) the verified review */
  reviewPath: string | null;
  reviewed: boolean;
  /** The customer's active packages/memberships */
  plans: PublicPlanDto[];
}

export interface PublicBusinessDto {
  name: string;
  slug: string;
  businessType: BusinessType;
  timezone: string;
  locale: Locale;
  phone: string | null;
  hours: BusinessHours;
  services: Pick<ServiceDto, 'id' | 'name' | 'durationMin' | 'priceCents' | 'photoUrl'>[];
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
  resources: Pick<ResourceDto, 'id' | 'name' | 'color' | 'serviceIds' | 'capacity' | 'pricePerHourCents' | 'description' | 'locationId' | 'photoUrl'>[];
  /** Kinds that book by duration: the lengths offered */
  rentalDurations: number[] | null;
  /** Active locations; the booking page asks which one when there are several */
  locations: PublicLocationDto[];
  /** Banner, profile picture, gallery, social links and notice */
  page: PageSettings & { gallery: string[] };
  /** Verified reviews: average, count and the latest ones */
  reviews: ReviewSummaryDto;
  /** Promotions customers can see: coupon box and the loyalty reward */
  promos: { coupons: boolean; reward: Pick<RewardSettings, 'everyVisits' | 'discountType' | 'value'> | null };
  /** Packages and gift cards for sale online (null = not selling online) */
  shop: PublicShopDto | null;
}

/** A customer's active package/membership as shown to them */
export interface PublicPlanDto {
  name: string;
  /** null = unlimited */
  sessionsLeft: number | null;
  expiresOn: string | null;
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
  /** Total price of the booking (after any discount) */
  priceCents: number;
  discountCents: number;
  discountReason: 'reward' | 'coupon' | 'package' | null;
  /** Packages/memberships the customer has active ("te quedan 3 clases") */
  plans: PublicPlanDto[];
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


// ---------- Packages, memberships and gift cards ----------

export const offeringInputSchema = z
  .object({
    kind: z.enum(['package', 'membership']),
    name: z.string().trim().min(2).max(80),
    priceCents: z.number().int().min(0).max(100_000_000),
    /** Package: sessions included. Membership: per month (null = unlimited) */
    sessions: z.number().int().min(1).max(1000).nullable().optional(),
    /** Package validity in days */
    validityDays: z.number().int().min(1).max(1095).nullable().optional(),
    serviceIds: z.array(z.string().uuid()).max(200).default([]),
    active: z.boolean().default(true),
  })
  .refine((o) => o.kind !== 'package' || (o.sessions != null && o.validityDays != null), { path: ['sessions'], message: 'package_needs_sessions' });
export type OfferingInput = z.infer<typeof offeringInputSchema>;
export interface OfferingDto {
  id: string;
  kind: 'package' | 'membership';
  name: string;
  priceCents: number;
  sessions: number | null;
  validityDays: number | null;
  serviceIds: string[];
  active: boolean;
  /** Customers with it active today */
  activeCount: number;
}

/** Manual methods to take money for a sale (online sales come later). */
export const SALE_METHODS = ['cash', 'card', 'transfer'] as const;
export const planSaleSchema = z.object({
  offeringId: z.string().uuid(),
  method: z.enum(SALE_METHODS),
  /** Price actually charged; defaults to the catalog price */
  priceCents: z.number().int().min(0).optional(),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  locationId: z.string().uuid().optional(),
});
export interface PlanUseDto {
  appointmentId: string;
  startsAt: string;
  serviceName: string;
  sessions: number;
}
export interface CustomerPlanDto {
  id: string;
  kind: 'package' | 'membership';
  name: string;
  serviceIds: string[];
  sessionsTotal: number | null;
  sessionsUsed: number;
  /** null = unlimited */
  sessionsLeft: number | null;
  priceCents: number;
  startsOn: string;
  expiresOn: string | null;
  /** 'active' | 'used_up' | 'expired' | 'cancelled' */
  status: 'active' | 'used_up' | 'expired' | 'cancelled';
  uses: PlanUseDto[];
}

export const giftCardSaleSchema = z.object({
  amountCents: z.number().int().min(100).max(10_000_000),
  method: z.enum(SALE_METHODS),
  /** Who buys it (the payment is theirs) */
  customerId: z.string().uuid(),
  recipientName: z.string().trim().max(120).nullable().optional(),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  locationId: z.string().uuid().optional(),
});
export interface GiftCardDto {
  id: string;
  code: string;
  initialCents: number;
  balanceCents: number;
  customerId: string | null;
  customerName: string | null;
  recipientName: string | null;
  expiresOn: string | null;
  createdAt: string;
}
/** Pay (part of) a booking with a gift card balance. */
export const giftCardRedeemSchema = z.object({
  code: z.string().trim().min(4).max(20),
  appointmentId: z.string().uuid(),
  amountCents: z.number().int().min(1),
});
/** Plans a completed booking can take a session from ("cobrar normal" = none). */
export interface PlanChoiceDto {
  id: string;
  name: string;
  sessionsLeft: number | null;
  expiresOn: string | null;
}

// ---------- Client record (expediente) ----------

export const recordUpdateSchema = z.object({
  allergies: z.string().trim().max(2000).nullable().optional(),
  conditions: z.string().trim().max(2000).nullable().optional(),
  /** Tick the customer's consent (stores date and who registered it) */
  consent: z.boolean().optional(),
});
export const recordNoteSchema = z.object({
  body: z.string().trim().min(1).max(4000),
  appointmentId: z.string().uuid().nullable().optional(),
});
export interface RecordNoteDto {
  id: string;
  body: string;
  appointmentId: string | null;
  authorName: string | null;
  createdAt: string;
}
export interface RecordPhotoDto {
  id: string;
  kind: 'before' | 'after' | 'other';
  note: string | null;
  appointmentId: string | null;
  sizeBytes: number;
  createdAt: string;
}
export interface CustomerRecordDto {
  allergies: string | null;
  conditions: string | null;
  consentAt: string | null;
  consentByName: string | null;
  notes: RecordNoteDto[];
  photos: RecordPhotoDto[];
  /** Photos are set up on the server (private storage connected) */
  photosEnabled: boolean;
  /** Answered questionnaires, newest first */
  responses: FormResponseDto[];
}
export const RECORD_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

// ---------- Commissions and cash ----------

export interface CommissionRowDto {
  resourceId: string;
  resourceName: string;
  completed: number;
  soldCents: number;
  commissionCents: number;
}
export interface CommissionLineDto {
  appointmentId: string;
  resourceName: string;
  startsAt: string;
  serviceName: string;
  customerName: string;
  priceCents: number;
  pct: number;
  commissionCents: number;
}
export interface CommissionReportDto {
  rows: CommissionRowDto[];
  lines: CommissionLineDto[];
}

/** Methods shown in a cash closing (gift cards spend balance, not cash) */
export const CASH_METHODS = ['cash', 'card', 'transfer', 'mercadopago', 'spei', 'gift_card'] as const;
export interface CashSummaryDto {
  day: string;
  locationId: string;
  /** Money taken for bookings, per method */
  byMethod: Record<string, number>;
  /** Sales of packages, memberships, gift cards and counter sales (included in byMethod) */
  salesCents: number;
  salesByKind: { packages: number; memberships: number; giftCards: number; products: number };
  expectedCashCents: number;
  totalCents: number;
}
export const cashClosingSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  locationId: z.string().uuid(),
  countedCashCents: z.number().int().min(0).max(1_000_000_000),
  notes: z.string().trim().max(500).nullable().optional(),
});
export interface CashClosingDto {
  id: string;
  day: string;
  locationId: string;
  locationName: string;
  byMethod: Record<string, number>;
  salesCents: number;
  expectedCashCents: number;
  countedCashCents: number;
  differenceCents: number;
  notes: string | null;
  closedByName: string | null;
  createdAt: string;
}

// ---------- Reviews ----------

export const reviewInputSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(1000).nullable().optional(),
});
export const reviewModerationSchema = z.object({
  reply: z.string().trim().max(1000).nullable().optional(),
  hidden: z.boolean().optional(),
});
export interface ReviewDto {
  id: string;
  appointmentId: string;
  authorName: string;
  rating: number;
  comment: string | null;
  reply: string | null;
  repliedAt: string | null;
  hidden: boolean;
  serviceName: string | null;
  locationName: string | null;
  createdAt: string;
}
/** Public: first name + initial only */
export interface PublicReviewDto {
  authorName: string;
  rating: number;
  comment: string | null;
  reply: string | null;
  createdAt: string;
}
export interface ReviewSummaryDto {
  average: number | null;
  count: number;
  recent: PublicReviewDto[];
}
export interface ReviewRequestDto {
  businessName: string;
  serviceName: string;
  startsAt: string;
  /** Already reviewed (shows it read-only) */
  review: PublicReviewDto | null;
  /** The visit isn't completed yet */
  notYet: boolean;
}

// ---------- Calendar subscription (iCal) ----------

export interface CalendarFeedDto {
  scope: 'business' | 'location' | 'resource';
  locationId: string | null;
  resourceId: string | null;
  label: string;
  /** https URL to the .ics (secret) */
  url: string;
}
export const calendarFeedTargetSchema = z.object({
  scope: z.enum(['business', 'location', 'resource']),
  locationId: z.string().uuid().nullable().optional(),
  resourceId: z.string().uuid().nullable().optional(),
});


// ---------- Questionnaires (cuestionarios por tipo de cita) ----------

export const FORM_FIELD_TYPES = ['text', 'longtext', 'yesno', 'choice', 'multi', 'number', 'date'] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];
export const formFieldSchema = z.object({
  /** Stable id inside the form (answers point to it) */
  id: z.string().regex(/^[a-z0-9]{4,12}$/),
  label: z.string().trim().min(1).max(200),
  type: z.enum(FORM_FIELD_TYPES),
  required: z.boolean().default(false),
  /** For 'choice' and 'multi' */
  options: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
  help: z.string().trim().max(200).nullable().optional(),
});
export type FormField = z.infer<typeof formFieldSchema>;
export const formInputSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(500).nullable().optional(),
    fields: z.array(formFieldSchema).min(1).max(40),
    /** Booking types (services) it is filled on; a form can be on several */
    serviceIds: z.array(z.string().uuid()).max(200).default([]),
    active: z.boolean().default(true),
  })
  .refine((f) => f.fields.every((x) => !['choice', 'multi'].includes(x.type) || x.options.length >= 2), { path: ['fields'], message: 'choice_needs_options' })
  .refine((f) => new Set(f.fields.map((x) => x.id)).size === f.fields.length, { path: ['fields'], message: 'duplicate_field' });
export type FormInput = z.infer<typeof formInputSchema>;
export interface FormDto {
  id: string;
  name: string;
  description: string | null;
  fields: FormField[];
  serviceIds: string[];
  active: boolean;
  responses: number;
}
/** A form's questions (to fill it in a booking) */
export interface PublicFormDto {
  id: string;
  name: string;
  description: string | null;
  fields: FormField[];
  serviceIds: string[];
}
export type FormAnswerValue = string | number | boolean | string[] | null;
export const formAnswersSchema = z.object({
  formId: z.string().uuid(),
  values: z.record(z.string(), z.union([z.string().max(4000), z.number(), z.boolean(), z.array(z.string().max(100)).max(20), z.null()])),
});
export type FormAnswersInput = z.infer<typeof formAnswersSchema>;

/** Checks answers against the form; returns the error code or null. */
export function checkFormAnswers(fields: FormField[], values: Record<string, FormAnswerValue>): string | null {
  for (const f of fields) {
    const v = values[f.id];
    const empty = v == null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (f.required) return 'form_required';
      continue;
    }
    if (f.type === 'yesno' && typeof v !== 'boolean') return 'form_invalid';
    if (f.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) return 'form_invalid';
    if (f.type === 'date' && (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v))) return 'form_invalid';
    if (f.type === 'choice' && (typeof v !== 'string' || !f.options.includes(v))) return 'form_invalid';
    if (f.type === 'multi' && (!Array.isArray(v) || v.some((x) => !f.options.includes(x)))) return 'form_invalid';
    if ((f.type === 'text' || f.type === 'longtext') && typeof v !== 'string') return 'form_invalid';
  }
  return null;
}

/** An answered questionnaire as stored (labels snapshotted) */
export interface FormAnswerDto {
  /** Field id at the time it was answered (to pre-fill an edit) */
  fieldId?: string;
  label: string;
  type: FormFieldType;
  value: FormAnswerValue;
}
export interface FormResponseDto {
  id: string;
  formId: string | null;
  formName: string;
  appointmentId: string | null;
  serviceName: string | null;
  appointmentAt: string | null;
  answers: FormAnswerDto[];
  source: 'customer' | 'staff';
  authorName: string | null;
  createdAt: string;
}
/** Forms of a booking: the ones for its service, answered or not */
export interface AppointmentFormDto {
  form: PublicFormDto;
  response: FormResponseDto | null;
}


// ---------- Online sales (packages, memberships, gift cards on the booking page) ----------

/** What a pending online payment buys; fulfilled when Mercado Pago confirms it. */
export type OnlinePurchase =
  | { kind: 'plan'; offeringId: string }
  | { kind: 'gift_card'; amountCents: number; recipientName: string | null };

export interface PublicOfferingDto {
  id: string;
  kind: 'package' | 'membership';
  name: string;
  priceCents: number;
  sessions: number | null;
  validityDays: number | null;
  /** Names of the services it covers (empty = all) */
  serviceNames: string[];
}
export interface PublicShopDto {
  offerings: PublicOfferingDto[];
  /** Gift card amounts in cents (empty = none) */
  giftCardAmounts: number[];
}

export const publicPurchaseSchema = z
  .object({
    kind: z.enum(['plan', 'gift_card']),
    offeringId: z.string().uuid().optional(),
    amountCents: z.number().int().min(10_000).max(5_000_000).optional(),
    recipientName: z.string().trim().max(120).nullable().optional(),
    name: z.string().trim().min(2).max(120),
    phone: phoneSchema,
    email: z.string().trim().toLowerCase().email().optional().or(z.literal('').transform(() => undefined)),
    method: z.enum(['mercadopago', 'spei']).default('mercadopago'),
  })
  .refine((p) => (p.kind === 'plan' ? Boolean(p.offeringId) : p.amountCents != null), { path: ['kind'], message: 'missing_item' });
export type PublicPurchaseInput = z.infer<typeof publicPurchaseSchema>;

export interface PurchaseStatusDto {
  status: 'pending' | 'paid' | 'failed' | 'refunded';
  kind: 'plan' | 'gift_card';
  itemName: string;
  amountCents: number;
  businessName: string;
  slug: string;
  /** Once paid */
  giftCardCode: string | null;
  recipientName: string | null;
  plan: { sessionsLeft: number | null; expiresOn: string | null } | null;
}
export * from './catalogs';
export * from './invoicing';
export * from './pos';
