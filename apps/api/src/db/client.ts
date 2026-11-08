import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let db: Db | undefined;

/**
 * Lazily creates the connection pool. In Lambda, `DATABASE_URL` is set at cold start
 * (see lambda.ts) before the first query, so we can't create the pool at import time.
 */
export function getDb(): Db {
  if (db) return db;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  pool = new pg.Pool({
    connectionString: url,
    // Lambda: keep the pool tiny; each concurrent invocation has its own container.
    max: Number(process.env.DB_POOL_MAX ?? (process.env.AWS_LAMBDA_FUNCTION_NAME ? 2 : 10)),
    idleTimeoutMillis: 30_000,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  db = drizzle(pool, { schema });
  return db;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
  db = undefined;
}
