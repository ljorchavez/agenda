// AWS Lambda run automatically after each deploy (CDK Trigger) to apply DB migrations.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from './db/migrate.js';
import { loadSecrets } from './lib/secrets.js';

export const handler = async () => {
  await loadSecrets();
  // CDK bundling copies /migrations next to the bundle.
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
  await runMigrations(dir);
  return { ok: true };
};
