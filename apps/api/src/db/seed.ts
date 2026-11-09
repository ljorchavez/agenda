/** Demo data: `pnpm db:seed` (the data itself lives in demo-data.ts). */
import { closeDb } from './client.js';
import { seedDemo } from './demo-data.js';

seedDemo()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => closeDb());
