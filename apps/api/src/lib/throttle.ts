import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { AppError } from './errors.js';

/** A limit: at most `max` attempts for `key` in the last `minutes`. */
export interface Limit {
  key: string;
  max: number;
  minutes: number;
}

/**
 * Login: per person and device (ip+email) it's strict, so one visitor mistyping the demo password
 * never locks it for everyone else; per ip it stops one machine trying many accounts; per email
 * it stops a slow attack on one account from many machines.
 */
export const loginLimits = (ip: string, email: string): Limit[] => [
  { key: `login:${ip}:${email}`, max: 5, minutes: 15 },
  { key: `login-ip:${ip}`, max: 30, minutes: 15 },
  { key: `login-email:${email}`, max: 100, minutes: 15 },
];

/** Reset requests: a few per hour per email (no inbox flooding) and per ip. */
export const forgotLimits = (ip: string, email: string): Limit[] => [
  { key: `forgot:${email}`, max: 3, minutes: 60 },
  { key: `forgot-ip:${ip}`, max: 10, minutes: 60 },
];

export const resetLimits = (ip: string): Limit[] => [{ key: `reset-ip:${ip}`, max: 20, minutes: 15 }];

/** Client IP as Vercel reports it (x-real-ip), with fallbacks for local runs. */
export function clientIp(c: Context): string {
  const real = c.req.header('x-real-ip');
  if (real) return real.trim();
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return 'unknown';
}

export const tooManyAttempts = (minutes: number) =>
  new AppError(429, 'too_many_attempts', `Too many attempts. Try again in ${minutes} minutes.`);

/** Throws 429 when any limit is already used up. */
export async function assertNotLimited(db: Pick<Db, 'execute'>, limits: Limit[]): Promise<void> {
  for (const l of limits) {
    const res = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from auth_attempts
      where key = ${l.key} and created_at > now() - make_interval(mins => ${l.minutes})`);
    if ((res.rows[0]?.n ?? 0) >= l.max) throw tooManyAttempts(l.minutes);
  }
}

/** Counts one attempt against every limit. */
export async function recordAttempt(db: Pick<Db, 'execute'>, limits: Limit[]): Promise<void> {
  if (!limits.length) return;
  const values = sql.join(limits.map((l) => sql`(${l.key})`), sql`, `);
  await db.execute(sql`insert into auth_attempts (key) values ${values}`);
}

export async function clearAttempts(db: Pick<Db, 'execute'>, keys: string[]): Promise<void> {
  for (const key of keys) await db.execute(sql`delete from auth_attempts where key = ${key}`);
}

/** Daily cleanup: old attempts and expired reset links. */
export async function pruneAuthTables(db: Pick<Db, 'execute'>): Promise<void> {
  await db.execute(sql`delete from auth_attempts where created_at < now() - interval '1 day'`);
  await db.execute(sql`delete from password_resets where expires_at < now()`);
}

/**
 * Public forms (bookings, purchases, reviews, changes to a booking): counts every request per
 * device and answers 429 past `max` in `minutes`, so a script can't flood a business.
 */
export async function limitPublic(db: Pick<Db, 'execute'>, c: Context, name: string, max: number, minutes = 60): Promise<void> {
  if (process.env.NODE_ENV === 'test' && !process.env.TEST_PUBLIC_LIMITS) return;
  const limits = [{ key: `${name}-ip:${clientIp(c)}`, max, minutes }];
  await assertNotLimited(db, limits);
  await recordAttempt(db, limits);
}
