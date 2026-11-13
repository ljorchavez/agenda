import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  APPOINTMENT_SOURCES,
  APPOINTMENT_STATUSES,
  BUSINESS_TYPES,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  ROLES,
  type BusinessHours,
  type FormField,
  type OnlinePurchase,
  type ClinicalAuthor,
  type CustomerFiscal,
  type SaleItem,
  type StockReason,
  type Professional,
  type PlanId,
  type BillingStatus,
  type WorkHours,
  type TenantSettings,
} from '@agenda/shared';

export const roleEnum = pgEnum('role', ROLES);
export const businessTypeEnum = pgEnum('business_type', BUSINESS_TYPES);
export const appointmentStatusEnum = pgEnum('appointment_status', APPOINTMENT_STATUSES);
export const appointmentSourceEnum = pgEnum('appointment_source', APPOINTMENT_SOURCES);
export const paymentMethodEnum = pgEnum('payment_method', PAYMENT_METHODS);
export const paymentStatusEnum = pgEnum('payment_status', PAYMENT_STATUSES);

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** A tenant is one business (one paying customer of the platform). */
export const tenants = pgTable(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    businessType: businessTypeEnum('business_type').notNull().default('other'),
    phone: text('phone'),
    timezone: text('timezone').notNull().default('America/Mexico_City'),
    currency: text('currency').notNull().default('MXN'),
    locale: text('locale').notNull().default('es'),
    settings: jsonb('settings').$type<TenantSettings>().notNull(),
    /** Business's own Mercado Pago access token, AES-256-GCM encrypted. Never sent to clients. */
    mpAccessTokenEnc: text('mp_access_token_enc'),
    /** Mercado Pago account nickname/email shown in settings */
    mpAccount: text('mp_account'),
    /** Facturapi issuer {orgId, testKey, liveKey}, AES-256-GCM encrypted. Never sent to clients. */
    invoicingEnc: text('invoicing_enc'),
    // Public profile (booking page + directory)
    description: text('description'),
    address: text('address'),
    neighborhood: text('neighborhood'),
    city: text('city'),
    state: text('state'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    /** Opt-in: show this business in the public directory/map */
    directoryListed: boolean('directory_listed').notNull().default(false),
    /** Subscription plan of this business (limits in packages/shared PLAN_LIMITS) */
    plan: text('plan').$type<PlanId>().notNull().default('free'),
    /** Card subscription: none | pending (waiting for the card) | active | past_due | cancelled */
    billingStatus: text('billing_status').$type<BillingStatus>().notNull().default('none'),
    /** Subscription id at the provider (Mercado Pago preapproval) */
    billingSubscriptionId: text('billing_subscription_id'),
    /** Plan the owner chose and is paying for; becomes `plan` when the provider confirms */
    billingPendingPlan: text('billing_pending_plan').$type<PlanId>(),
    /** Monthly amount (IVA included) the subscription charges */
    billingAmountCents: integer('billing_amount_cents'),
    /** First failed charge; after a grace period the business goes read-only */
    billingPastDueSince: timestamp('billing_past_due_since', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('tenants_slug_idx').on(t.slug),
    index('tenants_directory_idx').on(t.directoryListed, t.businessType),
  ],
);




export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    /** Sessions issued before this moment are rejected (set when the password is reset). */
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    /** Cédula, institution and specialty for clinical documents */
    professional: jsonb('professional').$type<Professional | null>(),
    /** Two-step sign-in (TOTP): secret encrypted with lib/crypto; enabled once confirmed with a code */
    totpSecretEnc: text('totp_secret_enc'),
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
    /** Last accepted 30-second step, so a code can't be used twice */
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    /** SHA-256 of the unused recovery codes */
    totpRecovery: jsonb('totp_recovery').$type<string[] | null>(),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

/** One-time "reset your password" links. Only a SHA-256 of the token is stored. */
export const passwordResets = pgTable(
  'password_resets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('password_resets_token_idx').on(t.tokenHash), index('password_resets_user_idx').on(t.userId)],
);

/** Failed logins and reset requests, counted per key (ip, email, ip+email) in a time window. */
export const authAttempts = pgTable(
  'auth_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_attempts_key_idx').on(t.key, t.createdAt)],
);

/** A person's access to a business: role and, optionally, a single location. */
export const memberships = pgTable(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull().default('staff'),
    /** Null = every location */
    locationId: uuid('location_id'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('memberships_tenant_user_uq').on(t.tenantId, t.userId), index('memberships_user_idx').on(t.userId)],
);

/** Sucursales. Every business has exactly one primary location (created by a DB trigger). */
export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    phone: text('phone'),
    /** For the primary location, null address/coords mean "use the business profile" */
    address: text('address'),
    neighborhood: text('neighborhood'),
    city: text('city'),
    state: text('state'),
    lat: doublePrecision('lat'),
    lng: doublePrecision('lng'),
    /** Null = business hours */
    hours: jsonb('hours').$type<BusinessHours>(),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => [index('locations_tenant_idx').on(t.tenantId)],
);

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    notes: text('notes'),
    birthday: date('birthday'),
    /** Patient data (health businesses) */
    sex: text('sex').$type<'F' | 'M' | 'X'>(),
    address: text('address'),
    curp: text('curp'),
    /** Hidden from lists; clinical records must be kept 5 years (NOM-004 5.4) */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /** Fiscal data to invoice them (RFC, razón social, régimen, CP, uso CFDI) */
    fiscal: jsonb('fiscal').$type<CustomerFiscal>(),
    ...timestamps,
  },
  (t) => [
    index('customers_tenant_idx').on(t.tenantId),
    uniqueIndex('customers_tenant_phone_idx')
      .on(t.tenantId, t.phone)
      .where(sql`${t.phone} is not null`),
  ],
);

export const services = pgTable(
  'services',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    durationMin: integer('duration_min').notNull(),
    priceCents: integer('price_cents').notNull().default(0),
    active: boolean('active').notNull().default(true),
    photoUrl: text('photo_url'),
    ...timestamps,
  },
  (t) => [index('services_tenant_idx').on(t.tenantId)],
);

/**
 * Whatever gets booked: a person (barber, doctor, instructor), a space (court, room) or a table.
 * One concept for every kind of business; capacity and hourly price are optional for all.
 */
export const resources = pgTable(
  'resources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Filled by a DB trigger with the primary location when omitted */
    locationId: uuid('location_id').notNull().default(sql`null`),
    name: text('name').notNull(),
    color: text('color').notNull().default('#0f766e'),
    active: boolean('active').notNull().default(true),
    /** Services it takes; empty = all */
    serviceIds: jsonb('service_ids').$type<string[]>().notNull().default([]),
    /** Login linked to it (that person sees only its bookings) */
    userId: uuid('user_id'),
    /** People that fit at once (table seats, court players); null = no limit */
    capacity: integer('capacity'),
    /** When set, bookings are priced by the hour */
    pricePerHourCents: integer('price_per_hour_cents'),
    description: text('description'),
    /** Own working hours; null = the hours of its location */
    hours: jsonb('hours').$type<WorkHours>(),
    photoUrl: text('photo_url'),
    /** Commission: general percent, replaced per service by commissionByService[serviceId] */
    commissionPct: numeric('commission_pct', { precision: 5, scale: 2 }),
    commissionByService: jsonb('commission_by_service').$type<Record<string, number>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    index('resources_tenant_idx').on(t.tenantId, t.locationId),
    uniqueIndex('resources_user_uq').on(t.tenantId, t.userId).where(sql`user_id is not null`),
  ],
);

/** One occurrence of a group class with limited spots. Attendees are appointments. */
export const classSessions = pgTable(
  'class_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
    /** Instructor */
    resourceId: uuid('resource_id').references(() => resources.id, { onDelete: 'set null' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    capacity: integer('capacity').notNull(),
    /** scheduled | cancelled */
    status: text('status').notNull().default('scheduled'),
    notes: text('notes'),
    /** Location (sucursal). Filled with the primary location by a DB trigger when omitted. */
    locationId: uuid('location_id').notNull().default(sql`null`),
    ...timestamps,
  },
  (t) => [index('class_sessions_tenant_starts_idx').on(t.tenantId, t.startsAt)],
);

/** Discount codes a business hands out ("VERANO10"). */
export const coupons = pgTable('coupons', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  discountType: text('discount_type').$type<'percent' | 'amount'>().notNull(),
  /** Percent (1–100) or cents */
  value: integer('value').notNull(),
  active: boolean('active').notNull().default(true),
  maxUses: integer('max_uses'),
  validUntil: date('valid_until', { mode: 'string' }),
  /** Services it applies to (empty = all) */
  serviceIds: jsonb('service_ids').$type<string[]>().notNull().default([]),
  /** Times one customer can use it (null = no limit) */
  maxUsesPerCustomer: integer('max_uses_per_customer'),
  ...timestamps,
});
export type Coupon = typeof coupons.$inferSelect;

export const appointments = pgTable(
  'appointments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    serviceId: uuid('service_id')
      .notNull()
      .references(() => services.id, { onDelete: 'restrict' }),
    staffUserId: uuid('staff_user_id').references(() => users.id, { onDelete: 'set null' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    status: appointmentStatusEnum('status').notNull().default('scheduled'),
    priceCents: integer('price_cents').notNull().default(0),
    source: appointmentSourceEnum('source').notNull().default('staff'),
    notes: text('notes'),
    /** Internal 1–5 rating of how the visit went (only the business sees it) */
    rating: smallint('rating'),
    /** Restaurants: number of people and assigned table */
    partySize: integer('party_size'),
    resourceId: uuid('resource_id').references(() => resources.id, { onDelete: 'set null' }),
    classSessionId: uuid('class_session_id').references(() => classSessions.id, { onDelete: 'cascade' }),
    /** Location (sucursal). Filled with the primary location by a DB trigger when omitted. */
    locationId: uuid('location_id').notNull().default(sql`null`),
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
    /** Discount already taken off priceCents ('reward' every N visits, or 'coupon') */
    discountCents: integer('discount_cents').notNull().default(0),
    discountReason: text('discount_reason').$type<'reward' | 'coupon' | 'package'>(),
    couponId: uuid('coupon_id').references(() => coupons.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('appointments_tenant_starts_idx').on(t.tenantId, t.startsAt),
    index('appointments_customer_idx').on(t.customerId),
    index('appointments_reminder_idx').on(t.startsAt, t.reminderSentAt),
    index('appointments_resource_starts_idx').on(t.resourceId, t.startsAt),
    index('appointments_class_session_idx').on(t.classSessionId),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    appointmentId: uuid('appointment_id').references(() => appointments.id, {
      onDelete: 'set null',
    }),
    amountCents: integer('amount_cents').notNull(),
    method: paymentMethodEnum('method').notNull(),
    status: paymentStatusEnum('status').notNull().default('paid'),
    /** e.g. 'mercadopago' when processed online */
    provider: text('provider'),
    /** Provider's payment/order id, used to reconcile webhooks */
    providerRef: text('provider_ref'),
    checkoutUrl: text('checkout_url'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    notes: text('notes'),
    /** Where the money was taken (sales with no booking); else the booking's location */
    locationId: uuid('location_id'),
    /** Sale of a package/membership or of a gift card */
    customerPlanId: uuid('customer_plan_id'),
    soldGiftCardId: uuid('sold_gift_card_id'),
    /** Gift card used to pay (method 'gift_card') */
    giftCardId: uuid('gift_card_id'),
    /** Online sale: what this payment buys; fulfilled when it is paid (lib/online-sales) */
    purchase: jsonb('purchase').$type<OnlinePurchase | null>(),
    /** Counter sale (POS) this payment belongs to */
    saleId: uuid('sale_id'),
    ...timestamps,
  },
  (t) => [
    index('payments_tenant_paid_idx').on(t.tenantId, t.paidAt),
    index('payments_customer_idx').on(t.customerId),
    uniqueIndex('payments_provider_ref_idx')
      .on(t.provider, t.providerRef)
      .where(sql`${t.providerRef} is not null`),
  ],
);

export const messageLogs = pgTable(
  'message_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    appointmentId: uuid('appointment_id').references(() => appointments.id, {
      onDelete: 'set null',
    }),
    channel: text('channel').notNull().default('whatsapp'),
    template: text('template').notNull(),
    toPhone: text('to_phone').notNull(),
    /** queued | sent | delivered | read | failed | dry_run */
    status: text('status').notNull(),
    providerMessageId: text('provider_message_id'),
    error: text('error'),
    ...timestamps,
  },
  (t) => [
    index('message_logs_tenant_idx').on(t.tenantId),
    index('message_logs_provider_idx').on(t.providerMessageId),
  ],
);

export type Tenant = typeof tenants.$inferSelect;
export type User = typeof users.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Location = typeof locations.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Service = typeof services.$inferSelect;
export type Appointment = typeof appointments.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type Resource = typeof resources.$inferSelect;
export type ClassSession = typeof classSessions.$inferSelect;

/** Times nobody can book: the whole business, one location or one resource (vacation, holiday…). */
export const timeBlocks = pgTable(
  'time_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** Both null = the whole business */
    locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
    resourceId: uuid('resource_id').references(() => resources.id, { onDelete: 'cascade' }),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('time_blocks_tenant_idx').on(t.tenantId, t.startsAt)],
);
export type TimeBlock = typeof timeBlocks.$inferSelect;

// ---------- Packages, memberships and gift cards ----------

/** What a business sells ahead: packages (N sessions within D days) and monthly memberships. */
export const offerings = pgTable('offerings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<'package' | 'membership'>().notNull(),
  name: text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  /** Package: sessions included. Membership: sessions per month (null = unlimited) */
  sessions: integer('sessions'),
  /** Package validity in days (memberships last a month) */
  validityDays: integer('validity_days'),
  /** Services it covers; empty = all */
  serviceIds: jsonb('service_ids').$type<string[]>().notNull().default([]),
  active: boolean('active').notNull().default(true),
  ...timestamps,
});
export type Offering = typeof offerings.$inferSelect;

/** A package or a month of membership sold to a customer. */
export const customerPlans = pgTable('customer_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  offeringId: uuid('offering_id').references(() => offerings.id, { onDelete: 'set null' }),
  kind: text('kind').$type<'package' | 'membership'>().notNull(),
  name: text('name').notNull(),
  serviceIds: jsonb('service_ids').$type<string[]>().notNull().default([]),
  /** null = unlimited */
  sessionsTotal: integer('sessions_total'),
  priceCents: integer('price_cents').notNull(),
  startsOn: date('starts_on', { mode: 'string' }).notNull(),
  expiresOn: date('expires_on', { mode: 'string' }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  soldBy: uuid('sold_by'),
  ...timestamps,
});
export type CustomerPlan = typeof customerPlans.$inferSelect;

export const planUses = pgTable('plan_uses', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  customerPlanId: uuid('customer_plan_id').notNull().references(() => customerPlans.id, { onDelete: 'cascade' }),
  appointmentId: uuid('appointment_id').notNull().references(() => appointments.id, { onDelete: 'cascade' }),
  sessions: integer('sessions').notNull().default(1),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const giftCards = pgTable('gift_cards', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  code: text('code').notNull(),
  initialCents: integer('initial_cents').notNull(),
  balanceCents: integer('balance_cents').notNull(),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  recipientName: text('recipient_name'),
  expiresOn: date('expires_on', { mode: 'string' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  soldBy: uuid('sold_by'),
  ...timestamps,
});
export type GiftCard = typeof giftCards.$inferSelect;

// ---------- Client record ----------

export const customerRecords = pgTable('customer_records', {
  customerId: uuid('customer_id').primaryKey().references(() => customers.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  /** Encrypted with lib/crypto (encryptSecret) */
  allergiesEnc: text('allergies_enc'),
  conditionsEnc: text('conditions_enc'),
  consentAt: timestamp('consent_at', { withTimezone: true }),
  consentBy: uuid('consent_by'),
  updatedBy: uuid('updated_by'),
  ...timestamps,
});

export const recordNotes = pgTable('record_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),
  bodyEnc: text('body_enc').notNull(),
  authorId: uuid('author_id'),
  authorName: text('author_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const recordPhotos = pgTable('record_photos', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),
  /** before/after/other: photos; lab/imaging/document: studies in the clinical record */
  kind: text('kind').$type<'before' | 'after' | 'other' | 'lab' | 'imaging' | 'document'>().notNull(),
  noteEnc: text('note_enc'),
  /** Random path in the private Blob store; never shown to customers */
  blobPath: text('blob_path').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  contentType: text('content_type').notNull(),
  createdBy: uuid('created_by'),
  /** Shown to the patient in their portal since */
  sharedAt: timestamp('shared_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------- Cash, reviews, calendar ----------

export const cashClosings = pgTable('cash_closings', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
  day: date('day', { mode: 'string' }).notNull(),
  byMethod: jsonb('by_method').$type<Record<string, number>>().notNull(),
  salesCents: integer('sales_cents').notNull().default(0),
  expectedCashCents: integer('expected_cash_cents').notNull(),
  countedCashCents: integer('counted_cash_cents').notNull(),
  notes: text('notes'),
  closedBy: uuid('closed_by'),
  closedByName: text('closed_by_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const reviews = pgTable('reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  appointmentId: uuid('appointment_id').notNull().references(() => appointments.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'set null' }),
  authorName: text('author_name').notNull(),
  rating: integer('rating').notNull(),
  comment: text('comment'),
  reply: text('reply'),
  repliedAt: timestamp('replied_at', { withTimezone: true }),
  hidden: boolean('hidden').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const calendarFeeds = pgTable('calendar_feeds', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  token: text('token').notNull(),
  scope: text('scope').$type<'business' | 'location' | 'resource'>().notNull(),
  locationId: uuid('location_id').references(() => locations.id, { onDelete: 'cascade' }),
  resourceId: uuid('resource_id').references(() => resources.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------- Questionnaires ----------

/** A reusable questionnaire, asked on the booking types (services) it is attached to. */
export const forms = pgTable('forms', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  fields: jsonb('fields').$type<FormField[]>().notNull().default([]),
  serviceIds: jsonb('service_ids').$type<string[]>().notNull().default([]),
  /** Unused: questionnaires are filled by the team during the appointment */
  askOnline: boolean('ask_online').notNull().default(true),
  active: boolean('active').notNull().default(true),
  ...timestamps,
});
export type Form = typeof forms.$inferSelect;

/** Answers to a questionnaire; part of the client record (encrypted). */
export const formResponses = pgTable('form_responses', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),
  formId: uuid('form_id').references(() => forms.id, { onDelete: 'set null' }),
  /** Snapshot: renaming or editing the form later doesn't change past answers */
  formName: text('form_name').notNull(),
  /** encryptSecret(JSON of [{ label, type, value }]) */
  answersEnc: text('answers_enc').notNull(),
  source: text('source').$type<'customer' | 'staff'>().notNull(),
  authorId: uuid('author_id'),
  authorName: text('author_name'),
  ...timestamps,
});

/** Clinical documents (historia clínica, notas, receta, consentimiento…). Signed ones never change. */
export const clinicalNotes = pgTable(
  'clinical_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    appointmentId: uuid('appointment_id').references(() => appointments.id, { onDelete: 'set null' }),
    template: text('template').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    /** encryptSecret(JSON of the field values) */
    contentEnc: text('content_enc').notNull(),
    status: text('status').$type<'draft' | 'signed'>().notNull().default('draft'),
    authorId: uuid('author_id'),
    /** Snapshot of who wrote/signed it (name, cédula, specialty) */
    author: jsonb('author').$type<ClinicalAuthor | null>(),
    signedAt: timestamp('signed_at', { withTimezone: true }),
    contentHash: text('content_hash'),
    amendsId: uuid('amends_id'),
    /** Shown to the patient in their portal since */
    sharedAt: timestamp('shared_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('clinical_notes_customer_idx').on(t.tenantId, t.customerId, t.createdAt)],
);
export type ClinicalNote = typeof clinicalNotes.$inferSelect;

/** Who opened, signed, printed or exported a clinical record (bitácora). */
export const recordAccessLog = pgTable(
  'record_access_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
    userId: uuid('user_id'),
    userName: text('user_name'),
    action: text('action').notNull(),
    detail: text('detail'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('record_access_log_customer_idx').on(t.tenantId, t.customerId, t.createdAt)],
);

// ---------- Electronic invoicing (CFDI with Facturapi) ----------

// ---------- Point of sale ----------

export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sku: text('sku'),
    category: text('category'),
    priceCents: integer('price_cents').notNull(),
    costCents: integer('cost_cents'),
    trackStock: boolean('track_stock').notNull().default(true),
    minStock: integer('min_stock'),
    iva: text('iva').$type<'16' | '0' | 'exento'>().notNull().default('16'),
    satKey: text('sat_key'),
    requiresPrescription: boolean('requires_prescription').notNull().default(false),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => [index('products_tenant_idx').on(t.tenantId)],
);
export type Product = typeof products.$inferSelect;

export const productStock = pgTable(
  'product_stock',
  {
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    qty: integer('qty').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.locationId] })],
);

export const sales = pgTable(
  'sales',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    items: jsonb('items').$type<SaleItem[]>().notNull(),
    totalCents: integer('total_cents').notNull(),
    status: text('status').$type<'paid' | 'canceled'>().notNull().default('paid'),
    notes: text('notes'),
    createdBy: uuid('created_by'),
    createdByName: text('created_by_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    canceledBy: uuid('canceled_by'),
    clientId: text('client_id'),
    offline: boolean('offline').notNull().default(false),
  },
  (t) => [
    uniqueIndex('sales_tenant_number_idx').on(t.tenantId, t.number),
    index('sales_tenant_created_idx').on(t.tenantId, t.createdAt),
    uniqueIndex('sales_tenant_client_idx').on(t.tenantId, t.clientId).where(sql`client_id is not null`),
  ],
);
export type Sale = typeof sales.$inferSelect;

export const stockMoves = pgTable(
  'stock_moves',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
    qtyChange: integer('qty_change').notNull(),
    qtyAfter: integer('qty_after').notNull(),
    reason: text('reason').$type<StockReason>().notNull(),
    saleId: uuid('sale_id').references(() => sales.id, { onDelete: 'set null' }),
    note: text('note'),
    createdBy: uuid('created_by'),
    createdByName: text('created_by_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('stock_moves_product_idx').on(t.productId, t.createdAt)],
);

export const invoices = pgTable(
  'invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    customerId: uuid('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    facturapiId: text('facturapi_id').notNull(),
    uuid: text('uuid'),
    series: text('series'),
    folio: integer('folio'),
    totalCents: integer('total_cents').notNull(),
    status: text('status').$type<'valid' | 'canceled' | 'pending'>().notNull().default('valid'),
    test: boolean('test').notNull().default(false),
    receiverRfc: text('receiver_rfc'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
  },
  (t) => [index('invoices_tenant_idx').on(t.tenantId, t.createdAt), index('invoices_payment_idx').on(t.paymentId)],
);
export type Invoice = typeof invoices.$inferSelect;

/** Unexpected errors (API and browser), grouped by fingerprint; new ones are emailed (lib/monitor.ts). */
export const errorEvents = pgTable(
  'error_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fingerprint: text('fingerprint').notNull(),
    source: text('source').notNull(),
    message: text('message').notNull(),
    stack: text('stack'),
    path: text('path'),
    userAgent: text('user_agent'),
    tenantId: uuid('tenant_id'),
    count: integer('count').notNull().default(1),
    firstSeen: timestamp('first_seen', { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
    lastAlertedAt: timestamp('last_alerted_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('error_events_fingerprint_idx').on(t.fingerprint)],
);
