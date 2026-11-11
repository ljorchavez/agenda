/**
 * Runs on deploy: reseeds the demo businesses only when a demo (or the demo login) added in this
 * version is missing, so new demos show up right away instead of after the nightly reset.
 */
import { eq, inArray } from 'drizzle-orm';
import { closeDb, getDb } from './client.js';
import { DEMO_OWNER, seedDemo } from './demo-data.js';
import { tenants, users } from './schema.js';

const REQUIRED = ['dental-demo', 'psicologia-demo', 'fisioterapia-demo'];

async function main() {
  const db = getDb();
  const found = await db.select({ slug: tenants.slug }).from(tenants).where(inArray(tenants.slug, REQUIRED));
  const owner = await db.select({ id: users.id }).from(users).where(eq(users.email, DEMO_OWNER.email));
  if (found.length === REQUIRED.length && owner.length) return console.log('Demo data up to date');
  console.log('New demos missing: seeding demo data…');
  await seedDemo();
}

main()
  .catch((e) => {
    // Never block a deploy over demo data
    console.error('Demo seed skipped:', e);
  })
  .finally(() => closeDb());
