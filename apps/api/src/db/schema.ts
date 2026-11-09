import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
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
  type PlanId,
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
    ...timestamps,
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
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
    /** Restaurants: number of people and assigned table */
    partySize: integer('party_size'),
    resourceId: uuid('resource_id').references(() => resources.id, { onDelete: 'set null' }),
    classSessionId: uuid('class_session_id').references(() => classSessions.id, { onDelete: 'cascade' }),
    /** Location (sucursal). Filled with the primary location by a DB trigger when omitted. */
    locationId: uuid('location_id').notNull().default(sql`null`),
    reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
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
