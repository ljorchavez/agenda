import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb } from './client.js';

export async function runMigrations(migrationsFolder?: string): Promise<void> {
  const folder =
    migrationsFolder ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await migrate(getDb(), { migrationsFolder: folder });
}
