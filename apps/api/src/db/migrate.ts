import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb } from './client.js';

export async function runMigrations(migrationsFolder?: string): Promise<void> {
  const folder =
    migrationsFolder ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
  await migrate(getDb(), { migrationsFolder: folder });
}

// Executed directly: `pnpm db:migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => {
      console.log('Migrations applied');
      return closeDb();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
