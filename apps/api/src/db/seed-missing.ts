/**
 * Runs on deploy: reseeds the demo businesses only when a demo added in this version is missing,
 * so new demos show up right away instead of after the nightly reset.
 */
import { inArray } from 'drizzle-orm';
import { closeDb, getDb } from './client.js';
import { seedDemo } from './demo-data.js';
import { tenants } from './schema.js';

const REQUIRED = ['dental-demo', 'psicologia-demo', 'fisioterapia-demo'];

async function main() {
  const found = await getDb().select({ slug: tenants.slug }).from(tenants).where(inArray(tenants.slug, REQUIRED));
  if (found.length === REQUIRED.length) return console.log('Demo data up to date');
  console.log('New demos missing: seeding demo data…');
  await seedDemo();
}

main()
  .catch((e) => {
    // Never block a deploy over demo data
    console.error('Demo seed skipped:', e);
  })
  .finally(() => closeDb());
