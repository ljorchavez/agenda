// `pnpm db:migrate` — applies pending SQL migrations from apps/api/migrations
import { closeDb } from './client.js';
import { runMigrations } from './migrate.js';

runMigrations()
  .then(() => console.log('Migrations applied'))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
