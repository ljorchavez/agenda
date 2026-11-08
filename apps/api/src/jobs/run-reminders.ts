// Local helper: `pnpm --filter @agenda/api reminders:run`
import { closeDb } from '../db/client.js';
import { sendDueReminders } from './reminders.js';

sendDueReminders()
  .then((r) => console.log('Reminders:', r))
  .finally(() => closeDb());
